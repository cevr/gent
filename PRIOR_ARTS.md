# Prior arts

Fetch with `okra repo fetch <slug>`; get the path with `okra repo path <slug>`. `okra repo list` prints hundreds of kilobytes; use `path`. A path in "Read it for" starts with the repo's directory name (`opencode/…`), so it never reads as a gent path.

## Repos

| Slug                            | Branch  | Sweep            | Read it for                                                                                                                                                                                                                                                                                                 | Compare with                                                                               |
| ------------------------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sst/opencode`                  | `v2`    | architecture, ui | Effect-native runner and codemode: `opencode/packages/core/src/session/runner/step.ts`, `runner/llm.ts`, `session/inbox.ts`; docked panes, dialogs, theme tokens, permission prompts (source only unless a binary is on PATH)                                                                               | `packages/core/src/runtime/turn.ts`, `packages/core/src/runtime/agent-loop.ts`, `apps/tui` |
| `badlogic/pi-mono`              | `pico`  | architecture, ui | Minimal core: `pi-mono/packages/agent/src/agent-loop.ts`; minimal chrome, editor keys, model and session pickers (`pi` on PATH)                                                                                                                                                                             | `packages/core/src/runtime/agent-loop.ts`, `apps/tui`                                      |
| `openai/codex`                  | default | architecture     | `input_queue.rs`, turn and tool orchestration                                                                                                                                                                                                                                                               | `packages/core/src/runtime/agent-loop.ts`                                                  |
| `primeintellect-ai/prime-agent` | default | architecture     | RLM kernel: `prime-agent/packages/agent/src/agent-loop.ts`                                                                                                                                                                                                                                                  | `packages/extensions/src/cell.ts`                                                          |
| `exoharness/exo`                | default | architecture     | `exo/exoharness/typescript/model-runtime/turn-loop.ts`                                                                                                                                                                                                                                                      | `packages/core/src/runtime/turn.ts`                                                        |
| `deepseek-ai/deepseek-harness`  | default | architecture     | `deepseek-harness/packages/core/agent-loop/src/agent.ts`                                                                                                                                                                                                                                                    | `packages/core/src/runtime/agent-loop.ts`                                                  |
| `vercel-labs/fx`                | default | ui               | The ui sweep's first reference: shell-like inline output that keeps scrollback, the input line, slash commands, streaming and tool-call rendering, the settle-then-capture pty tests (`fx/tests/e2e`); release binary by `gh release download --repo vercel-labs/fx --pattern '*linux*' --dir <scratch>/fx` | `apps/tui`, `packages/e2e/src/pty-fixture.ts`                                              |
| `UsefulSoftwareCo/executor`     | default | architecture     | MCP and tool sourcing: connection pool, catalog staleness, OAuth outside the SDK, `tools.search` ranking                                                                                                                                                                                                    | `packages/extensions/src/mcp.ts`                                                           |

## Other sources

| Source                           | Sweep      | Read it for                                                                                                                                                                                               |
| -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor's harness notes (2026-09) | efficiency | cost per task by billing type, prompt and tool-schema trimming, cache layout, sparse line numbers, reasoning continuity; summarized in [docs/architecture/efficiency.md](docs/architecture/efficiency.md) |

## Settled

- Line counts across these repos compare different scopes (one file against gent's whole loop). Draw no size conclusion from them.
- gent's step policy (`classifyStep` in `packages/core/src/runtime/turn.ts`, a pure function with a table test) already matches opencode v2: adopted.
- The queue-as-one-module shape (opencode `inbox.ts`, codex `input_queue.rs`) is adopted: `packages/core/src/runtime/agent-loop.ts`.
- fx's settle-then-capture pty method is adopted: `packages/e2e/src/pty-fixture.ts`.
- No prior art persists a step position or replays in-flight tool calls. gent's exact mid-turn resume (in `packages/core/src/runtime/agent-loop.ts` and `packages/core/src/runtime/turn.ts`) is a capability the owner keeps or drops; a sweep does not decide it.
- The yield of every comparison so far was bugs found while reading gent with the prior art in mind, more than code removed.
- Rejected from prior art: an LLM permission reviewer, a static tool table, a mutex event queue, unbounded steps, whole-log replay, text-blob compaction (`NORTH_STAR.md` → Rejected).

## To survey

None open.
