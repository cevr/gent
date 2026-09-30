# UI sweep

Every pass sweeps the TUI as a user sees it, next to the prior-art TUIs, run side by side in herdr panes. The **objective** is one consistent interaction model: the same key does the same thing on every surface, every state has a visible way out, and nothing gent draws is worse than what a prior-art agent draws for the same moment. The code-reading `tui` area finds structure; this area finds what only a rendered screen shows.

## Reference TUIs

| Agent                            | Read it for                                                                                                                                                    | How to run it                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vercel-labs/fx (first reference) | Shell-like inline output that keeps scrollback, the input line, slash commands, streaming and tool-call rendering, settle-then-capture pty tests (`tests/e2e`) | Release binary into the scratch directory: `gh release download --repo vercel-labs/fx --pattern '*linux*' --dir <scratch>/fx`. Never the `curl … \| bash` installer. |
| badlogic/pi-mono (branch `pico`) | Minimal chrome, editor keys, model and session pickers                                                                                                         | `pi` on PATH                                                                                                                                                         |
| sst/opencode (branch `v2`)       | Docked panes, dialogs, theme tokens, permission prompts                                                                                                        | Source only unless a binary is on PATH                                                                                                                               |

Sources live under `okra repo path <slug>`; read the TUI code and e2e captures for any screen the running binary cannot reach without a model.

## How to run

- gent: `bun run --cwd <warm source>/apps/tui dev --debug` with `GENT_DATA_DIR` and `HOME` under the scratch directory. `--debug` uses the scripted model, so a conversation, streaming, tool calls and errors render with no paid call.
- A reference TUI runs with `HOME` (and `XDG_*`) under the scratch directory and no credentials, so it can never reach a paid model. Screens that need a model come from its source and test captures instead. A login prompt is a screen to compare, not a step to complete.
- One herdr tab per comparison, split into panes of the same size: `herdr pane split`, `herdr pane run <pane> '<cmd>'`, `herdr pane send-keys` / `send-text` to drive, `herdr pane wait-output` to settle, `herdr pane read` to capture. Never `herdr agent`. Close every pane and tab the sweep opened before the report.
- Capture each screen at two sizes (a normal pane and a narrow one near 60×20) and after a resize.

## Checklist (one row per moment, gent against each reference)

1. Launch and empty state: what the first screen says, where the cursor is, the time to first input.
2. Input: multiline entry, paste (large and bracketed), history recall, editor keys (word jump, kill line), submit vs newline.
3. Streaming: text, reasoning, tool calls, long tool output, diffs; scrollback kept or lost; follow vs manual scroll.
4. Interrupt and exit: Esc, Ctrl+C ladder, Ctrl+D; what a cancelled turn leaves on screen.
5. Slash commands and pickers: discovery, filtering, empty result, Esc out; model and session pickers.
6. Asks and prompts: approval, question, handoff; docked pane, never modal (owner rule).
7. Errors and notices: provider error, retry, overflow/compaction notice; wording and placement.
8. Status: model, context gauge, cost, cwd, busy state.
9. Selection and copy (OSC 52), links, mouse.
10. Consistency inside gent: the same key or word means the same thing on every surface; each pane shows its way out.

## Report

Beyond the usual candidate table: a matrix of the checklist rows × (gent, fx, pi, opencode) with one line each, the `herdr pane read` capture paths for every gent row, and for each candidate the reference screen it borrows from. Owner rules hold: docked panes, not modals. A candidate that only matches a reference's taste, with no user-facing gain, goes in "not worth a pass".
