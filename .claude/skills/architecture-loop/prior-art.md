# Prior art

Fetch with `okra repo fetch <slug>`; get the path with `okra repo path <slug>`. `okra repo list` prints hundreds of kilobytes; use `path`.

| Slug                            | Branch  | Read it for                                                                                   |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `sst/opencode`                  | `v2`    | Effect-based. `packages/core/src/session/runner/step.ts`, `runner/llm.ts`, `session/inbox.ts` |
| `badlogic/pi-mono`              | `pico`  | Minimalism. `packages/agent/src/agent-loop.ts`                                                |
| `openai/codex`                  | default | `input_queue.rs`, turn and tool orchestration                                                 |
| `primeintellect-ai/prime-agent` | default | `packages/agent/src/agent-loop.ts`                                                            |
| `exoharness/exo`                | default | `exoharness/typescript/model-runtime/turn-loop.ts`                                            |
| `deepseek-ai/deepseek-harness`  | default | `packages/core/agent-loop/src/agent.ts`                                                       |
| `vercel-labs/fx`                | default | TUI standard, pty test method (settle, then capture)                                          |

## Settled comparisons

- Line counts across these repos compare different scopes (one file against gent's whole loop directory). Draw no size conclusion from them.
- gent's step policy (`classifyStep`, a pure function with a table test) already matches opencode v2.
- The queue-as-one-module shape (opencode `inbox.ts`, codex `input_queue.rs`) is adopted: `packages/core/src/runtime/agent-loop.ts`.
- fx's settle-then-capture pty method is adopted: `packages/e2e/src/pty-fixture.ts`.
- No prior art persists a step position or replays in-flight tool calls. gent's exact mid-turn resume (about 200 lines of `agent-loop.turn-execution.ts`) is a capability the owner keeps or drops; a sweep does not decide it.
- The yield of every comparison so far was bugs found while reading gent with the prior art in mind, more than code removed.
