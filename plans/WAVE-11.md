# Planify: Wave 11 — `needs:`-Derived Concurrency + Read-Safety

## Context

After Wave 10's full migration + surface collapse + deletion sweep

- post-deletion stabilization lands, the `tools` bucket on
  `defineExtension` looks like:

```ts
tools: [{
  id, input, output, description, prompt?, permissions?,
  resources?: ReadonlyArray<string>,   // free-form name keys for resource-manager
  idempotent?: boolean,                // hand-set, never validated
  handler,
}]
```

`resources` and `idempotent` are loose. `resources` strings are
hand-typed and never validated against the actual service set the
handler touches. `idempotent` is hand-set with no fence — author can
mark a write tool idempotent and ship it.

Wave 11 replaces both fields with one typed declaration: which
domain services this tool actually consumes. From that one signal
the runtime derives concurrency (named locks), read-safety (no
write-tagged service in the list), audit metadata, and sandbox
eligibility.

The cut applies the principles `derive-dont-sync` (one source of
truth — the service list — drives every downstream property),
`make-impossible-states-unrepresentable` (a tool needing a write
service cannot claim read-safe at compile-or-load time), and
`fail-with-typed-errors` (missing lock-registry entry is a typed
extension-load error, not a runtime defect).

The plan is not complete until every batch below is implemented,
gated, and reviewed once.

## Scope

- **In**: `needs: ReadonlyArray<Tag<any, any>>` field on `tools`
  bucket; central `LOCK_REGISTRY` mapping each service Tag to
  `{ kind: "read" | "write" | "none", locks: string[] }`;
  fail-closed validation at extension load (every `Tag` in `needs`
  must resolve to a registry entry); migration of ~25 tools to
  declare `needs`; deletion of `resources` and `idempotent` from
  the `tools` bucket type; downstream features that derive from
  `needs` (audit-mode metadata report, sandbox fast-path on
  read-safe-only turns, read-only sub-agent gate at the resolver).
- **Out (deferred to W12 audit)**: 9-lane recursive
  verification audit. See `plans/WAVE-12.md`.
- **Out**: extending the `needs` mechanism beyond `tools` (commands,
  rpc, keybinds keep their post-W10 shape — they don't drive
  concurrency).

## Constraints

- Correctness over pragmatism. Personal library; no shims, no
  parallel APIs.
- `migrate-callers-then-delete-legacy-apis`: migrate every tool
  call site to declare `needs` (W11-3) before the bucket type
  change drops `resources` / `idempotent` (W11-4).
- Each commit compiles and passes `bun run gate`.
- Sub-commits allowed inside W11-3 (~25-tool migration).
- Apply-tier delegation per CLAUDE.md: design-tier authors the
  `LOCK_REGISTRY` (W11-1), the bucket type change (W11-2), and
  the first 2-3 worked tool migrations; apply-tier subagent
  handles the recipe-execution tail of W11-3.

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Shape after W11

```ts
tools: [{
  id, input, output, description, prompt?, permissions?,
  needs: ReadonlyArray<Tag<any, any>>, // explicit service deps
  handler,
}]
```

Worked examples:

- `read.ts` (file read): `needs: [FileSystem]` — `FileSystem` is
  `kind: "write"` in the registry but `read.ts`'s handler only calls
  read-shaped methods, so the registry refines `FileSystem` per-method
  via a sub-Tag (e.g., `FileSystem.Read`) — see "Sub-Tag refinement"
  below.
- `write.ts` (file write): `needs: [FileSystem.Write, FileLockService]`.
- `task-list.ts`: `needs: [TaskStorage.Read]` — read-safe.
- `task-create.ts`: `needs: [TaskStorage]` — write-tagged, eligible
  for `"task-storage:db"` lock.

`resources` and `idempotent` both **derive** from `needs`:

- **Concurrency**: each `Tag` maps to zero or more lock names via
  `LOCK_REGISTRY`. Tools whose lock-name sets overlap serialize on
  the overlap; disjoint sets run parallel. (`resources`'s job today.)
- **Read-safety**: every `Tag` in the registry is annotated `read |
write | none`. A tool whose `needs` contains zero `write` Tags is
  read-safe — eligible for parallel sub-agent spawning, sandbox
  fast-path, "audit-only" run modes.
- **`idempotent`**: derives — read-safe tool with no
  side-effect-tagged services is idempotent. No hand-set bool.

## Sub-Tag refinement

For services where the per-method shape matters (read vs write on
the same Tag), introduce sub-Tags: `FileSystem.Read` is `kind:
"read"`, `FileSystem.Write` is `kind: "write"`. The handler asks
for the narrower Tag in its R-channel; the lock registry maps the
sub-Tag to the same lock-name pool as the parent. Authors only see
sub-Tags when they need them — default `FileSystem` is `"write"`
(safe pessimistic default).

## Central lock map (`runtime/locks.ts`)

```ts
export const LOCK_REGISTRY: ReadonlyMap<Tag<any, any>, LockEntry> = new Map([
  [Storage, { kind: "write", locks: ["storage:db"] }],
  [SessionStorage, { kind: "write", locks: ["storage:db"] }],
  [EventStore, { kind: "write", locks: ["storage:events"] }],
  [FileSystem, { kind: "write", locks: [] }], // path-keyed via FileLockService
  [FileSystem.Read, { kind: "read", locks: [] }],
  [FileSystem.Write, { kind: "write", locks: [] }],
  [FileLockService, { kind: "write", locks: [] }],
  [Provider, { kind: "none", locks: [] }],
  [Clock, { kind: "none", locks: [] }],
  // …one entry per service Tag the runtime knows about
])
```

`SessionStorage` and `Storage` both list `"storage:db"` so a tool
needing one and a tool needing the other still serialize against
the same SQLite connection. `Provider` is `none` because two tools
both calling the LLM are network-bound and have no in-process
contention.

## Fail-closed validation at extension load

When `defineExtension({ tools: [...] })` runs in
`registerExtensions`, every `Tag` in every tool's `needs` must
resolve to a `LOCK_REGISTRY` entry. Missing entry → typed error
(`UnknownNeedsTagError`), extension fails to load. This is the
load-bearing safety check: a new write-shaped service cannot ship
without an explicit decision about its lock set, so a future tool
that uses it can never run parallel-with-itself by accident.

## Why W11, not W10

- Keeps W10's scope tight (surface collapse only — no semantic
  changes to concurrency/safety).
- The `LOCK_REGISTRY` design needs the post-W10 service inventory
  to be stable — moving it earlier means rewriting the registry
  twice.
- Apply-tier delegation across ~25 tools wants the new bucket
  shape (post-W10) settled and tested first.

---

## Implementation Batches

### Commit 1: `feat(runtime): LOCK_REGISTRY — Tag → { kind, locks } map + fail-closed validation`

**Why W11-1 first**: every downstream commit consumes the registry.
Author it once, with care, before anything migrates.

**Files**: `packages/core/src/runtime/locks.ts` (new — `LockEntry`
schema, `LOCK_REGISTRY` map, `validateNeeds(needs): Effect<void,
UnknownNeedsTagError>`, `derive(needs): { lockNames: string[],
readSafe: boolean }`); typed error
`UnknownNeedsTagError extends Schema.TaggedError`; tests at
`packages/core/tests/runtime/locks.test.ts` covering: every
production service Tag has a registry entry; `validateNeeds` fails
typed on unknown Tag; `derive` returns correct lock-names + read-safe
for known mixes (read-only / write / none / mixed); registry covers
every Tag listed in `make-extension-host-context.ts` extension
layer.

**Verification**: `bun run gate`.

**Cites**: `derive-dont-sync`,
`make-impossible-states-unrepresentable`,
`fail-with-typed-errors`.

### Commit 2: `feat(extensions): tools bucket — needs field alongside resources/idempotent`

**Why W11-2**: introduce `needs` as an _additional_ optional field,
keeping `resources` and `idempotent` alive. This is the migrate
step — every tool gets `needs` declared in W11-3 before W11-4
deletes the old fields. Allows incremental migration with gate
green at every step.

**Files**: `packages/extensions/.../bucket-types.ts` (or wherever
the W10 `tools` bucket type lives) — add `needs?: ReadonlyArray<Tag<any,
any>>`; loader hooks `validateNeeds` at extension-load (warn if
`needs` declared but `resources`/`idempotent` also present, since
the authoritative-source ambiguity matters); tests covering
co-existence.

**Verification**: `bun run gate`.

**Cites**: `migrate-callers-then-delete-legacy-apis`,
`progressive-disclosure`.

### Commit 3: `refactor(extensions): migrate ~25 tools to declare needs`

**Why W11-3**: the bulk migration. Apply-tier delegation per
CLAUDE.md.

**Sub-commits permitted** (~25 files):

- **W11-3a**: design-tier migrates 2-3 worked examples
  (`read.ts` → read-safe, `write.ts` → write, one mixed —
  `task-create.ts` or `bash.ts`). Each migration also drops
  `resources` and `idempotent` _if and only if_ the derived
  values match — flagged for design-tier review when they
  diverge (likely some tools have mistakes in their hand-set
  values that `needs` reveals).
- **W11-3b**: apply-tier subagent migrates remaining ~22 tools
  using the W11-3a examples as recipe; reports back diff
  summary + any cases where derived values diverged from
  hand-set values + any cases where the tool's R-channel
  required a Tag missing from `LOCK_REGISTRY` (added in W11-1
  but possibly missed).

**Files**: ~25 files across `packages/extensions/src/**`. Tests
update alongside.

**Verification**: `bun run gate` (per sub-commit).

**Cites**: `derive-dont-sync`,
`migrate-callers-then-delete-legacy-apis`.

### Commit 4: `refactor(extensions,runtime): delete resources + idempotent — needs is single source`

**Why W11-4**: every tool declares `needs` (W11-3); the loader can
now require it and delete the old fields. Single commit, designed
to be reverted as a unit if W11-3 left a caller behind.

**Deletes**: `resources?` and `idempotent?` fields from `tools`
bucket type; any consumer of those fields that isn't already
sourced from `derive(needs)`; the loader's "warn if both declared"
branch from W11-2.

**Files**: bucket type definition; loader; resource-manager
integration (if any consumer reads `resources` field directly
instead of via `derive`); tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `subtract-before-you-add`,
`small-interface-deep-implementation`.

### Commit 5: `feat(runtime): downstream features — audit metadata + sandbox fast-path + read-only sub-agent gate`

**Why W11-5**: the features `needs` exists to enable. Audit-mode
metadata report (`tool-needs-audit.ts` — emit per-tool `{ readSafe:
bool, writes: Tag[], locks: string[] }` for review); sandbox
fast-path (turn whose tool calls all derive read-safe bypasses the
write-quorum / persistence flush, gate in `agent-loop.ts`);
read-only sub-agent resolver gate (parent agent spawning a
sub-agent with `readOnly: true` filters the resolved tool list to
read-safe-only, fail-closed if any non-read-safe tool was
explicitly requested).

**Files**: `runtime/tool-needs-audit.ts` (new), `agent-loop.ts`
(sandbox fast-path branch), sub-agent resolver (read-safe filter),
tests at `tests/runtime/tool-needs-audit.test.ts` and
`tests/runtime/sub-agent-readonly.test.ts`.

**Verification**: `bun run gate`.

**Cites**: `derive-dont-sync`,
`make-impossible-states-unrepresentable`.

---

**Next**: `plans/WAVE-12.md` — 9-lane recursive verification
audit on the fully settled W7 + W8 + W9 + W10 + W11 substrate.
