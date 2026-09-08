# Extension registration collapse

Status: proposal (2026-09-08). Not scheduled.

Question from the user: after reading opencode `v2` and pi `harness-v2/j4`, should gent
drastically simplify its plugin system while keeping Effect-native + actor model?

Answer: yes, but not by adopting either prior. Keep the substrate. Collapse the
registration surface from eight declaration buckets with three shapes each into two
primitives with one shape. Expressiveness stays; the compile pipeline shrinks.

## Receipts

- `docs/research/2026-09-08-opencode-v2-plugins.md` (opencode `v2` @ `cab8e39a`)
- `packages/core/src/domain/dynamic-extension-registry.ts` (runtime tool registry)
- `docs/research/2026-09-08-pi-v2-extensions.md` (pi `harness-v2/j4` @ `f7f933c6`)
- `packages/core/src/domain/extension.ts` (`defineExtension`, `hook.*`, `tool`, `request`)
- `packages/core/src/runtime/extensions/loader.ts`, `activation.ts`, `registry.ts`,
  `extension-hooks.ts`, `extension-effect-membrane.ts`, `extension-hook-context.ts`,
  `extension-capability-context.ts`, `driver-registry.ts`, `host-platform.ts`
- `packages/extensions/src/goal/index.ts`, `packages/extensions/src/btw/index.ts`
  (the two newest extensions; what a typical author writes today)

## What the priors do

| Concern        | opencode v2                                         | pi v1/v2                                              | gent today                                                                   |
| -------------- | --------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Definition     | `Plugin.define({ id, effect(ctx) })`, Effect-native | `(pi) => void` factory, Promise                       | `defineExtension({ 8 buckets })`, Effect-native                              |
| Primitives     | 2: `transform` + `hook`                             | 1: `pi.on(event, fn)` (37 events) + `pi.registerTool` | 5 hook kinds + tools + requests + agents + resources + jobs + 2 driver kinds |
| Registration   | scope-owned; unregister on scope close; hot reload  | mutable arrays; reload = restart                      | compiled once by a nine-file loader; no per-extension scope                  |
| Builtins       | are plugins                                         | are not                                               | are extensions (`BuiltinExtensions`)                                         |
| Authority      | ctx object passed in                                | `pi` object passed in                                 | `yield* ExtensionContext` inside leaves (no ctx param)                       |
| Tool metadata  | plain record                                        | plain record                                          | AiTool brand + metadata lowering at provider edge                            |
| Slash commands | plugin domain                                       | `registerCommand`                                     | `request({ slash })` → RPC plumbing + TUI client extension                   |

Both priors keep one truth gent already has: hook handlers are the only observation
channel, and authority comes from a host object, not from imports. Neither has an
actor model or durable state; both are weaker than gent there. So the substrate stays.

## What is heavy in gent

1. Eight buckets × three shapes (`tools`, `requests`, `agents`, `resources`,
   `scheduledJobs`, `hooks`, `modelDrivers`, `externalDrivers`; each accepts a value,
   a record, or a `defineX` helper). The loader normalizes all of them separately.
2. Two-layer membrane. `extension-effect-membrane.ts` wraps every leaf, and
   `extension-hook-context.ts` wraps every hook again with a different facet set.
3. Facet provision per call site. `ExtensionContext` is rebuilt for every tool call and
   every hook fire instead of once per branch actor.
4. Tool metadata lives on the `AiTool` brand and is lowered at the provider edge;
   the registry cannot answer "which tools exist" without decoding brands.
5. Request/slash RPC plumbing. A slash command needs `request({ slash })`, an RPC
   group, a TUI `clientCommandContribution`, and a client resource. `/btw` is four files.
6. Nine-file loader with load → validate → activate → compile → snapshot phases and no
   per-extension `Scope`, so hot reload is impossible and failure isolation is manual.
7. ARCHITECTURE.md drifted (`reactions`, `turnBefore`, `messageOutput`). Fixed with
   this proposal; the drift is itself evidence the surface is too wide to keep honest.

## Proposal

Keep: Effect-native leaves, `ExtensionContext` facets, `yield*` authority (no ctx
params), typed `tool`/`request` constructors, resources, turn projection, scope
shadowing, project trust, the `Interaction` facade, and the branch actor as owner of
the compiled registry.

Collapse to two primitives, both scope-owned:

```ts
defineExtension({
  id,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost // no ctx param
    yield* host.register("tool", myTool) // typed domain registry
    yield* host.register("request", myRequest)
    yield* host.hooks.on("turnAfter", handler) // one typed event map
  }),
})
```

- `register(domain, value)`: one function over a typed domain map (`tool`, `request`,
  `agent`, `resource`, `job`, `modelDriver`, `externalDriver`). Registration lives in
  the extension `Scope`; closing the scope unregisters. Replaces eight buckets.
- `hooks.on(kind, handler)`: one registry with a typed event map. Replaces five hook
  buckets and the second membrane. Add the kinds the context plan needs
  (`context`, `messageEnd`, `sessionStart`, `compaction`) here, once.
- `setup: Effect<void, ExtensionLoadError, Scope | ExtensionHost>`. One membrane wraps
  `setup`; every registration inherits it.
- Tool metadata moves off the `AiTool` brand into the registry record. The provider
  edge lowers from the record. Subsumes `domain/dynamic-extension-registry.ts`.
- `ExtensionContext` facets are built once per branch actor and provided to every
  leaf and hook from the same context.
- Loader becomes three steps: load, activate (run `setup` in a per-extension scope),
  snapshot. The actor rebuilds the snapshot on a dirty flag at turn start. Hot reload
  is "close scope, run setup again."
- Slash commands: a `request({ slash })` registration auto-derives the RPC entry and
  a default TUI command contribution. Client extensions stay only for custom panes.

Do not adopt: Promise surfaces, npm-installed plugins, opencode's many domains
(auth, storage, format, ...), pi's 37-event flat list.

## Sequence (when scheduled)

1. `ExtensionHost` Tag + `register`/`hooks.on` over the existing registry types; both
   old and new shapes compile to the same snapshot. Gate green.
2. Migrate builtins (`goal`, `btw`, `cell`, `memory`, `skills`, providers). Delete the
   bucket normalizers as each bucket empties.
3. Single membrane; delete `extension-hook-context.ts`.
4. Facets once per branch actor.
5. Tool metadata off the brand; fold `dynamic-extension-registry.ts` into the domain registry.
6. Per-extension scope in the loader; hot reload test.
7. Slash auto-derivation; delete hand-written client commands that only forward.

Each step is its own commit with counsel review. Estimated blast radius: ~40 files
across core, extensions, and tui; split as above.

## Status (2026-09-08)

Steps 1 and 2 landed together with no compatibility layer: `defineExtension({ id, setup })`
is the only authoring shape, `setup` yields `ExtensionHost` (`packages/core/src/domain/extension-host.ts`)
and calls `register(domain, ...values)` / `on(kind, handler)`. The loader collects registrations
into the unchanged `ExtensionContributions` record, binds requests to the extension id, and
validates the package. The bucket normalizers (`FieldSpec`, `resolveField`,
`validateKnownExtensionInputBuckets`) and `ExtensionSetupContext` are deleted.

Decision: step 6 (per-extension `Scope`) is dropped. The live profile already re-runs `setup`
on refresh and the resource graph owns acquisition and release; a second lifecycle owner would
add a scope with nothing to close. Hot reload remains a profile refresh.

Step 3 landed: `provideExtensionLeaf(frame)` in
`packages/core/src/runtime/extensions/extension-effect-membrane.ts` is the one boundary tools,
requests, and hooks cross. It reads the run's `CurrentExtensionHostContext`, layers the leaf frame
(extension id, tool call id, turn), and provides the `ExtensionContext` facets plus the capability
context. `extension-hook-context.ts` and its two tags are deleted; the turn projection is an input
to `resolveTurnProjection(projection)`, not ambient context.

Step 4 resolved by step 3: the host context is already built once per run by
`ExtensionHostContextProvider.forRun` and read through one tag; the facets are thin closures over
it. A separate per-branch facet cache would duplicate the run record for no measured gain.

Step 7 is already satisfied: the TUI derives a command for every server `SlashCommandInfo`
(`apps/tui/src/extensions/context.tsx`, `listSlashCommands`). The three client commands that remain
(`/driver`, `/loop`, `/btw`) do client-only work (driver client RPC, composing a message, opening an
overlay), so none is a pure forwarder to delete.

Remaining: 5 (tool metadata off the brand, fold `domain/dynamic-extension-registry.ts`). Deferred
behind the context plan; the registry already decodes the brand once at compile time, so the gain is
structural, not behavioral.
