# UI sweep

Every pass sweeps the TUI as a user sees it, next to the prior-art TUIs, run side by side in herdr panes. The **objective** is one consistent interaction model: the same key does the same thing on every surface, every state has a visible way out, and nothing gent draws is worse than what a prior-art agent draws for the same moment. The code-reading `tui` area finds structure; this area finds what only a rendered screen shows.

## Reference TUIs

The references are the `ui` rows of [`PRIOR_ARTS.md`](../../PRIOR_ARTS.md): vercel-labs/fx first, then pi and opencode, each with what to read and how to run it. Never the `curl … | bash` installer. Sources live under `okra repo path <slug>`; read the TUI code and e2e captures for any screen the running binary cannot reach without a model.

## How to run

- gent: `bun run --cwd <main checkout>/apps/tui dev --debug` with `GENT_DATA_DIR` and `HOME` under the scratch directory. `--debug` uses the scripted model, so a conversation, streaming, tool calls and errors render with no paid call.
- A reference TUI runs with `HOME` (and `XDG_*`) under the scratch directory and no credentials, so it can never reach a paid model. Screens that need a model come from its source and test captures instead. A login prompt is a screen to compare, not a step to complete.
- One herdr tab per comparison, split into panes of the same size: `herdr pane split`, `herdr pane run <pane> '<cmd>'`, `herdr pane send-keys` / `send-text` to drive, `herdr pane wait-output` to settle, `herdr pane read` to capture. Never `herdr agent`. Close every pane and tab the sweep opened before the report.
- A repeatable check (a key sequence, a resize, a capture at each step) can run as a drive script instead: `bun packages/e2e/src/drive.ts <script.json>` runs any command on the e2e pty fixture with a live emulator and saves each capture (format in [`packages/e2e/README.md`](../../packages/e2e/README.md)). The same command and scratch environment rules hold.
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
