# AGENTS.md

Building gent - minimal, opinionated agent harness (built with Effect).

North stars: effect-native, actor-model, a lean core with maximal expressiveness through extensions, cheap per task (maximum efficiency and cache rate), and one interaction model. `NORTH_STAR.md` holds them and the owner rules, among them single files over fragmentation.

## Quick Start

```bash
bun install
bun run typecheck  # patched TypeScript 7 + Effect diagnostics, must pass clean; also compiles and lints the ts and tsx blocks of the steering docs
bun run typecheck:fast  # `bun check` on every package in about 2 s: type errors only, no Effect diagnostics (bun check ignores tsconfig plugins) and no steering-doc fences
bun run lint       # oxlint (gent rules + type-aware lints) and the guards (`bun run guards`)
bun run test       # Gate tests. NOT bare `bun test` (picks up flaky e2e)
bun run smoke      # Headless mode smoke test
bun run install:global  # Build, then install the gent and gent-cell pair through install.sh (~/.local/share/gent, linked from ~/.local/bin)
bun run clean      # Remove turbo caches (.turbo)
```

## Gotchas

- **Schema.Class JSON roundtrip** - `JSON.parse` returns plain objects. Use `Schema.decodeUnknownSync` to reconstruct instances.
- **Effect diagnostics** - Effect compiler suggestions are not TypeScript errors. Still fix them.
- **Steering code fences** - TypeScript examples compile and lint as extension or TUI source. Add `lint=test` to a test-code fence; mark incomplete examples with `<!-- illustrative: reason -->` above the fence.
- **Bun peer deps** - Bun resolves to minimum version; can cause version mismatches with @effect packages.
- **No `any` casts** - oxlint enforces. Causes type drift bugs. Import the owning type instead of redeclaring it.
- **Package boundary imports** - Extensions author against `@gent/core/extensions/api`, clients read `@gent/core/protocol`, hosts compose `@gent/core/host` and `@gent/core/host-bun`, tests use `@gent/core/test-utils`. The full entry rules are in `docs/architecture/extension-host.md` (Entry rules and extension authority).
- **Extension authority** - A leaf yields `ExtensionContext` for host facades and names its `resources`; files, processes and HTTP come from the Effect platform services. A shipped extension is never more privileged than a user extension. Read `docs/architecture/extension-host.md` (Entry rules and extension authority) before an extension change.
- **No self-imports** - Inside `packages/core/src/`, always use relative imports. Never `@gent/core/*`.
- **Effect.fn recursive** - For recursive generators, annotate variable type: `const fn: (...) => Effect<A,E,R> = Effect.fn(...)`
- **Wide event boundaries** - `WideEvent.set()` requires a `withWideEvent` boundary in scope. Import `WideEvent`, `WideEventBoundary`, and `withWideEvent` from `effect-wide-event` directly.
- **Structured logging** - Use `Effect.logWarning("msg").pipe(Effect.annotateLogs({ error: String(e) }))`. Never pass error as second positional arg to `Effect.logWarning`.
- **Process-shaped names** - Active source/test/module names should describe product behavior, not migration history. Avoid names like `batch12`, `wave14`, or `planify-migration` outside `plans/` and dated audit receipts.

## Architecture

Read `ARCHITECTURE.md` before implementing, then the area files it points to for your change. Update them when diverging.

## Effect Patterns

Use `effect` skill. Key patterns:

- Services: `Context.Service` + `Layer.effect`/`Layer.succeed`
- Errors: `Schema.TaggedError`
- Data: `Schema.Class` with branded IDs
- Tracing: `Effect.fn` for all service methods

## Code Style

- Telegraph style, minimal tokens
- Every service exposes a `Live` layer; add a `Test` layer only when there is a real alternative implementation worth a Tag. Language model tests use `LanguageModelLayers` instead of provider wrapper statics.
- Schema validation at boundaries
- **Tagged/discriminated unions use Effect Schema primitives.** Prefer `Schema.TaggedUnion` (or `Schema.TaggedStruct` + `Schema.toTaggedUnion` for kebab-case wire tags, or `Schema.TaggedError` for errors); do not hand-roll `{ _tag: "X" } | { _tag: "Y" }` literal unions.
- **File naming**: kebab-case everywhere (`agent-loop.ts`, `message-list.tsx`)
- **One file per concern.** A concern lives in one large file with section banners (`session.ts`, `agent-loop.ts`, `tools.ts`). A new file needs a reason: a process entry, a package entry, a module two concerns share, or a lint-scoped boundary.

## Testing

```bash
bun run test              # unit/integration, one turbo task per package
bun run test:e2e          # PTY + focused server-process lifecycle coverage (slow)
bun run gate              # typecheck + lint + fmt + build + test
```

The pre-commit hook runs the guards, and oxlint and oxfmt on the staged files, in under 10 s; a staged `.ts` or `.tsx` file also runs `bun run typecheck:fast` on every package's working tree. The Effect diagnostics, the steering-doc fences, build and the tests run only in `bun run gate` and CI: run the gate before a commit that changes behavior and before a handoff.

Every TUI change also needs `bun run test:e2e` and a live check before acceptance: the verify-gent skill (`.claude/skills/verify-gent/SKILL.md`) launches the real TUI on the scripted model in a scratch home, drives it from its feature map and keeps the captures, with no herdr. Read [the UI comparison method](docs/architecture/ui.md); exercise each changed ability at normal and narrow sizes, including resize, and compare with installed reference TUIs such as Codex, Pi and fx. Follow `NORTH_STAR.md` Owner rules for isolated debug runs and reference credentials. Record rendered captures and mark reference screens checked through source/tests when login or a model is required.

Test philosophy, the test tiers, the test layers example and the test gotchas (bun:sqlite, timeouts, failed extensions, the model catalog, the scripted models, test control flow) are in `docs/architecture/testing.md`; read it before you write or restructure a test.

## Documentation

| Path                          | Focus                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| `ARCHITECTURE.md`             | Index: noun model, rules, one pointer per area file                  |
| `NORTH_STAR.md`               | North stars, owner rules, project sweeps, live check, rejected       |
| `PRIOR_ART.md`                | Prior-art repos and settled comparisons                              |
| `docs/architecture/`          | Area files, the efficiency and ui sweep methods, the capture preload |
| `apps/tui/AGENTS.md`          | OpenTUI, Solid patterns                                              |
| `apps/tui/docs/cli.md`        | CLI usage (`bun run --cwd apps/tui dev …`), flags, headless runs     |
| `docs/loop.md`                | The architecture loop's baselines, pathspecs and workspace steps     |
| `.claude/skills/verify-gent/` | Live check: launch, doctor, drive the TUI and `gent ctl`, evidence   |
| `testbeds/gamut/README.md`    | Real-model live check (orchestrator only): `bun run gamut up`        |

## Architecture loop

The owner's `loop` skill reads `docs/loop.md` for what it needs from gent beyond `NORTH_STAR.md` and `PRIOR_ART.md`: the baseline and audit commands, the source roots, the workspace steps, the guards, the apply rules and the counsel questions.
