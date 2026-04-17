# Extension Authoring Guide

## Overview

Extensions add tools, agents, prompt sections, interceptors, projections,
queries, mutations, resources (long-lived state with optional state machines,
schedules, subscriptions, and lifecycle hooks), and drivers to gent.
The single authoring API is `defineExtension({ id, contributions })`.
Contributions are a flat array of typed values built with smart constructors
(`toolContribution`, `agentContribution`, `interceptorContribution`, …).
gent itself is a library used inside Effect programs — every contribution
returns `Effect`, no Promise edges.

## Discovery

Extensions are loaded from two directories:

| Scope   | Path                  | Precedence |
| ------- | --------------------- | ---------- |
| User    | `~/.gent/extensions/` | 1 (medium) |
| Project | `.gent/extensions/`   | 2 (high)   |

Within each directory:

- Top-level `*.ts`, `*.js`, `*.mjs` files are loaded
- Subdirectories with `index.ts`/`index.js`/`index.mjs` are loaded
- Files starting with `.` or `_` are skipped
- `*.client.{tsx,ts,js,mjs}` and `client.{tsx,ts,js,mjs}` are TUI-only
  (not loaded server-side)

**Per-file isolation**: One broken file does not suppress siblings. Each
file is loaded independently; failures are logged as warnings and the
extension is skipped.

**Scope precedence**: Higher scope wins for same-key contributions. Project
overrides User overrides Builtin. Same-scope contribution collisions
degrade the conflicting extension instead of crashing host startup.

## Disabling Extensions

Create `.gent/disabled-extensions.json`:

```json
["extension-id-to-disable"]
```

Both `~/.gent/disabled-extensions.json` (user-level) and
`.gent/disabled-extensions.json` (project-level) are merged.

## defineExtension

```ts
import { defineExtension, defineResource, toolContribution } from "@gent/core/extensions/api"

export default defineExtension({
  id: "my-ext",
  contributions: ({ ctx }) => [
    // ctx.cwd — project working directory
    // ctx.home — user home directory
    // ctx.fs / ctx.path / ctx.spawner — platform services
    toolContribution(MyTool),
    defineResource({ tag: MyService, scope: "process", layer: MyService.Live }),
  ],
})
```

The factory runs at **setup time** (not import time), receives setup
context, and returns either a `Contribution[]` or
`Effect<Contribution[], ExtensionLoadError>` for async setup.

## Contribution Kinds

Every contribution kind has a smart constructor. Order of registration
within an extension does not matter for any kind except lifecycle effects
(which compose in declaration order). Scope precedence handles cross-extension
collisions.

| Kind               | Smart constructor                                                                        | Purpose                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool               | `toolContribution(def)`                                                                  | Agent-callable tool                                                                                                                                |
| Agent              | `agentContribution(def)`                                                                 | Spawnable subagent                                                                                                                                 |
| Interceptor        | `interceptorContribution(d)`                                                             | Wrap a runtime pipeline (`prompt.system`, etc.)                                                                                                    |
| Projection         | `projectionContribution(p)`                                                              | Read-only view (prompt section / tool policy)                                                                                                      |
| Query              | `queryContribution(q)`                                                                   | Typed read-only RPC                                                                                                                                |
| Mutation           | `mutationContribution(m)`                                                                | Typed write RPC                                                                                                                                    |
| Resource           | `defineResource({ scope, layer, machine?, schedule?, subscriptions?, start?, stop? })`   | Long-lived state with explicit scope. `machine` carries the `effect-machine` state machine when the extension owns one.                            |
| Lifecycle Resource | `defineLifecycleResource({ scope, machine?, schedule?, subscriptions?, start?, stop? })` | Same as `defineResource` for the no-service case (Resource carries lifecycle / schedule / subscriptions / machine without exposing a service tag). |
| Permission rule    | `permissionRuleContribution(r)`                                                          | Allow/deny rule for tool patterns                                                                                                                  |
| Prompt section     | `promptSectionContribution(s)`                                                           | Static or dynamic system prompt fragment                                                                                                           |
| Command            | `commandContribution(c)`                                                                 | Slash command                                                                                                                                      |
| Model driver       | `modelDriverContribution(d)`                                                             | LLM provider                                                                                                                                       |
| External driver    | `externalDriverContribution(d)`                                                          | Out-of-process turn executor (e.g. ACP)                                                                                                            |

### Tool

```ts
import { defineTool } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const GreetTool = defineTool({
  name: "greet",
  description: "Say hello",
  params: Schema.Struct({
    name: Schema.String.annotate({ description: "Who to greet" }),
    count: Schema.optional(Schema.Number),
  }),
  execute: (params) => Effect.succeed(`Hello, ${params.name}!`),
})

export default defineExtension({
  id: "greet-ext",
  contributions: () => [toolContribution(GreetTool)],
})
```

### Agent

```ts
import { defineAgent, ModelId } from "@gent/core/extensions/api"

const helper = defineAgent({
  name: "helper",
  description: "Helper for specific tasks",
  model: ModelId.of("anthropic/claude-opus-4-6"),
  allowedTools: ["read", "write"],
})

export default defineExtension({
  id: "helper-ext",
  contributions: () => [agentContribution(helper)],
})
```

### Interceptor

Seven keys are defined; every handler returns Effect.

| Key                | Shape           | Purpose                          |
| ------------------ | --------------- | -------------------------------- |
| `prompt.system`    | Transform       | Modify the system prompt         |
| `tool.execute`     | Transform       | Intercept tool execution         |
| `permission.check` | Transform       | Override permission decisions    |
| `context.messages` | Transform       | Filter/modify context messages   |
| `tool.result`      | Transform       | Enrich/modify tool results       |
| `turn.before`      | Fire-and-forget | Pre-turn observation             |
| `turn.after`       | Fire-and-forget | Post-turn observation            |
| `message.input`    | Transform       | Transform user input before send |
| `message.output`   | Transform       | Transform assistant output       |

```ts
import { defineInterceptor } from "@gent/core/extensions/api"
import { Effect } from "effect"

export default defineExtension({
  id: "prompt-rules",
  contributions: () => [
    interceptorContribution(
      defineInterceptor("prompt.system", (input, next) =>
        next(input).pipe(Effect.map((s) => s + "\n## House rule\n…")),
      ),
    ),
    interceptorContribution(
      defineInterceptor("turn.after", (input, next) =>
        Effect.gen(function* () {
          yield* next(input)
          yield* Effect.logInfo(`Turn completed in ${input.durationMs}ms`)
        }),
      ),
    ),
  ],
})
```

### Prompt section

Static or dynamic. Dynamic sections may require services from the same
extension's Resource(s).

```ts
contributions: ({ ctx }) => [
  defineResource({ tag: MyService, scope: "process", layer: MyService.Live }),
  promptSectionContribution({
    id: "rules",
    content: "Be nice.",
    priority: 50,
  }),
  promptSectionContribution({
    id: "live",
    priority: 80,
    resolve: Effect.gen(function* () {
      const svc = yield* MyService
      return yield* svc.renderPromptSection()
    }),
  }),
]
```

### Permission rule

```ts
import { PermissionRule } from "@gent/core/extensions/api"

contributions: () => [
  permissionRuleContribution(
    new PermissionRule({
      tool: "bash",
      pattern: "rm\\s+-rf\\s+/",
      action: "deny",
    }),
  ),
]
```

### Resource

A long-lived service Layer with explicit scope. Multiple Resources from
one extension merge into one composition root.

```ts
contributions: ({ ctx }) => [
  defineResource({ tag: MyStorage, scope: "process", layer: MyStorage.Live }),
  defineResource({ tag: MyCache, scope: "process", layer: MyCache.Live }),
]
```

### Command

Slash commands available in the TUI / programmatic clients. Handler
returns Effect.

```ts
contributions: () => [
  commandContribution({
    name: "deploy",
    description: "Deploy the current branch",
    handler: (args, ctx) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Deploying ${args}…`)
      }),
  }),
]
```

### Schedule

Cron-scheduled host effects live on a Resource as part of `schedule`.

```ts
contributions: () => [
  defineLifecycleResource({
    scope: "process",
    schedule: [
      {
        id: "reflect",
        cron: "0 21 * * 1-5",
        target: {
          kind: "headless-agent",
          agent: "memory:reflect",
          prompt: "Reflect on recent sessions.",
        },
      },
    ],
  }),
]
```

### Pub/sub subscription

Pattern-matched event subscriptions live on a Resource. Handler returns
Effect. Patterns: exact match (`"ext:foo"`) or `"<prefix>:*"` wildcard
(`"agent:*"` matches all `"agent:<EventTag>"` channels).

```ts
contributions: () => [
  defineLifecycleResource({
    scope: "process",
    subscriptions: [
      {
        pattern: "agent:*",
        handler: (envelope) => Effect.logInfo(`pub/sub event ${envelope.channel}`),
      },
    ],
  }),
]
```

### Lifecycle

Resource lifecycle hooks. `start` runs at install time; `stop` runs at
scope teardown via Effect's per-scope LIFO finalizer ordering. Failures
in `start` log and degrade the Resource (other Resources keep running);
`stop` may not fail (Effect finalizer contract).

```ts
contributions: ({ ctx }) => [
  defineLifecycleResource({
    scope: "process",
    start: Effect.logInfo(`init for cwd=${ctx.cwd}`),
    stop: Effect.logInfo("shutdown"),
  }),
]
```

### Resource.machine

Stateful extensions attach a state machine to a Resource via the
`machine` field. The machine is an `effect-machine` `Machine` whose
transitions can declare effects (`QueueFollowUp`, `Interject`,
`BusEmit`, etc.) for the host runtime to dispatch. See
`packages/extensions/src/auto.ts` for a complete example. When the
extension owns a service Layer, declare both on one Resource:

```ts
defineResource({
  tag: MyService,
  scope: "process",
  layer: MyService.Live,
  machine: myMachine,
})
```

When the extension has no service Layer, use `defineLifecycleResource`:

```ts
defineLifecycleResource({
  scope: "process",
  machine: myMachine,
})
```

Validation: an extension may declare at most one Resource with `machine`
(otherwise the runtime would silently pick the first by array order).
Today only `scope: "process"` machines are accepted; session/branch-scope
machines are rejected at setup time until the per-cwd / ephemeral
composers wire Resource layers (C3 successor work).

### Driver / Projection / Query / Mutation

These primitives are documented inline at their domain-module sources:

- `packages/core/src/domain/driver.ts`
- `packages/core/src/domain/projection.ts`
- `packages/core/src/domain/query.ts`
- `packages/core/src/domain/mutation.ts`

Each has at least one in-tree example: providers (`packages/extensions/src/anthropic`,
`openai`, `google`, `mistral`, `bedrock`); ACP external drivers
(`packages/extensions/src/acp-agents`); task projection / queries / mutations
(`packages/extensions/src/task-tools`); memory vault projection
(`packages/extensions/src/memory`).

## Validation

The framework validates all loaded extensions before creating the registry:

- **Duplicate IDs** in same scope → conflicting extension degrades
- **Same-name tools/agents/drivers/prompt-sections** in same scope →
  conflicting extension degrades

Cross-scope: higher scope wins silently (project overrides user overrides
builtin).
