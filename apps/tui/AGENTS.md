# TUI Guidelines

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Source runs only: `apps/tui/bunfig.toml` declares `@opentui/solid/preload` for `bun` (top level) and `bun test` (`[test]`); run from `apps/tui`. Binary doesn't need it.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.
- **autoloadBunfig: false** - Required in `Bun.build` compile options, else binary tries to load bunfig at runtime.
- **Message part types** - Import shared message, event, and RPC types from `@gent/core/protocol` when a UI projection needs them. Never redeclare.
- **render() is async** - Use `Effect.promise(() => render(...))`, not `Effect.sync`.
- **File naming** - All files kebab-case: `message-list.tsx`, `workspace.tsx`.
- **Error boundaries** - Always wrap potentially failing operations in try/catch or Effect.tryPromise to prevent TUI crashes.
- **Exit pattern** - Use `renderer.destroy()` then `useEnv().shutdown()` for clean exit. Never `process.exit()` — it bypasses Effect scope finalizers (server lock cleanup, SQLite WAL checkpoint).
- **Intrinsic names** - Take the names from the opentui catalogue: some multi-word intrinsics use underscores (`tab_select`, `ascii_font`), `scrollbox` is one word.
- **Use `<For>`** - Never `.map()` for JSX lists; use `<For each={items}>{item => ...}</For>`.

## Components

`<box>` is the flexbox container. `<text>` holds text, with `<b>` and `<span style={{ fg }}>` inside. `<scrollbox>` scrolls; `stickyScroll stickyStart="bottom"` keeps it at the end. `<input>` takes keys only with its `focused` prop.

```tsx
<box flexDirection="column" border>
  <text>
    Plain, <b>bold</b> and <span style={{ fg: "#ff8800" }}>colored</span> text
  </text>
  <scrollbox stickyScroll stickyStart="bottom">
    <text>A line that scrolls</text>
  </scrollbox>
  <input focused placeholder="Type here" />
</box>
```

## Hooks

- `useRenderer()` - Get renderer for `renderer.destroy()` on exit, `renderer.getPalette()` for terminal colors
- `useKeyboard(handler)` - Key events, check `e.name === "escape"`
- `useTheme()` - Returns `{ theme, selected, all, mode, setMode, set }`. Theme colors are RGBA from `@opentui/core`.

## Theme System

Ported from opencode. Key patterns:

- `renderer.getPalette({ size: 16 })` queries terminal's ANSI palette via OSC
- System theme generated from terminal colors; fallback to the `fx` theme
- JSON themes in `src/themes/*.json` with `defs` + dark/light variants
- `resolveTheme(themeJson, mode)` resolves refs to RGBA values
- The palette's "Theme" level enumerates `all()`; "Mode" is the separate Dark/Light toggle. A ported theme may omit `selectedListItemText`/`backgroundMenu`; `resolveTheme` supplies both.

## Command Palette

- `Ctrl+P` opens palette
- One `Command` shape (`id`, `title`, `category`, optional `keybind`, `slash`, `aliases`, `onSelect`, `onSlash`) and one resolved list, `useExtensionUI().commands()`
- A keybind with no ctrl or meta (a bare key such as `left`) is a key the composer also reads, so it fires only while the composer is idle: an empty draft in editing mode, no overlay or docked pane, no interaction, the transcript collapsed (`composerIdle` in `session.tsx`). Any extension can bind one to a key that types nothing (an arrow, a function key). A bare key that types a character (`j`, `?`, `shift+j`, `space`) would take the first character of every message: `resolveCommands` refuses that keybind in every scope and lists it with the failed extensions; the command keeps its slash and palette row. A bare `escape` and a `ctrl+c` (with or without shift) are refused the same way (`REFUSED_KEYBINDS` in `loader-boundary.ts`): keybinds run before the Esc and ctrl+c ladders, so either would take the pane close, the turn cancel and the quit. `←` opens the agents pane this way; in the pane `←` or Esc closes it and `→` or Enter switches to the row, as `←`/`→` move between palette levels
- `resolveCommands` merges the session's own commands (`setSessionCommands`, builtin scope), client extension commands, and server slash commands (builtin scope). Precedence is project > user > builtin; a higher scope takes a slash or keybind from the earlier owner, and a same-scope claim is dropped and listed with the failed extensions

## Error Handling

- Wrap async operations in try/catch blocks
- Use Effect.tryPromise for operations that might fail
- Display errors in status bar or modal, don't crash the TUI

## Debugging

- Use `console.log()` for debug output - it appears in terminal after TUI exits

## Architecture

Startup blocks before render — `main.tsx` calls `waitForReady` + `resolveInteractiveBootstrap` before `render()`. No loading route.

Providers wrap app in `main.tsx`:

```
WorkspaceProvider → ClientProvider → ExtensionUIProvider → ComposerMemoryProvider → App
```

| Provider                   | Purpose                                             |
| -------------------------- | --------------------------------------------------- |
| `WorkspaceProvider`        | cwd, gitRoot, gitStatus - static workspace info     |
| `ClientProvider`           | transport client, session state, event stream       |
| `ExtensionUIProvider`      | extension loading, command list, composer dispatch  |
| `ComposerMemoryProvider`   | drafts, refusals, prompt history, startup prompt    |
| `SessionControllerContext` | session-scoped: auth gate, overlays, composer state |

State ownership rules:

- One workflow, one owner. If a flow has modes/transitions, give it one reducer or machine.
- Shared caches live under a provider/registry scope, not module globals.
- Projections stay local and dumb. Do not promote derived display state into a second writer.
- Render-local view unions in `src/` may be plain `_tag` unions. The root `CLAUDE.md` rule requiring `Schema.TaggedUnion` covers wire and domain data; a union built inline by one projection and matched in the same file decodes nothing, so a schema would add a runtime decode to a path with no untrusted input.
- Auth is a view (`auth.tsx`); it mounts as an overlay above the session view when the session controller's auth gate detects missing required providers.
- There is no router. `client.session()` says which session shows, `switchSession` is its one writer, and `App` keys the session mount on it.
- `useRuntime()` is zero-arg — reads `useClient()` internally.
- Composer reads from `SessionControllerContext`, not props.

Views (only 1):

- `src/app.tsx` — the boot flow and the session view; provides
  `SessionControllerContext`
- `src/session.tsx` — `createSessionController()` + context

The branch picker is a docked pane (`pickers.tsx`), not a
view. It draws `PickerFrame` like every other docked pane. The boot flow opens it over the mounted session when the resumed session
has more than one branch; escape quits, because no branch was chosen yet. The
command palette's "Branches" level switches branches after that.

The footer (composer, trays, docked panes) never outgrows the split-footer
region (`maxHeight` in `app.tsx`). While a docked pane is open the trays
hide (`TrayFrame` reads the `DockProvider` count each `PickerFrame` adds to),
so the pane the reader opened gets the rows. A list pane passes no size: its
`SelectList` reports the lines it draws (headings included) and its filter or
query row, and the frame adds its chrome and its note row and caps the sum
(`pickerHeight`: four rows of chrome, six body lines at most; the query row
sits outside the cap). A pane that is not a list (the btw transcript) asks
for a `height` outright. The note row is the pane's `detail` line, or its `error`
in the detail's place: a pane with a detail line keeps the row while the
detail is `None`, so it does not jump when the text arrives. The pane is
then the one box that gives way, in whole rows (`PickerFrame` sets a
`flexBasis`, not a `height`: OpenTUI turns shrinking off on a box whose
height is set); squeezed, it drops its key hint, then its title, before its
body's last row. Inside the body the order goes on: the note row gives way
first, then the `SelectList` headings, then its filter row, and one row stays
for the cursor (the list reads its rows from the frame). Under three rows
the frame drops its rules and note row too, so its one or two rows go to
the list. With a turn running, a terminal under 9 rows leaves a pane no
row: the frame then draws nothing, and a `KeyboardGate` keeps its scopes
from taking keys (register a pane's key scope inside its frame, so the gate
covers it). Keys go past it; Esc still closes it, an extension pane included, and never cancels the turn behind it (the boot branch picker and an enforced sign-in keep their Esc). The frame
reads its rows from the Yoga layout before each draw, because OpenTUI reports
a 0-row box as one row and sends no size change between them. A pane that draws
its own query line (the autocomplete popup, the command palette) passes it as
the list's `queryRow`, so it gives way as the filter row does. The composer
keeps its rows, but while its popup or palette is open it may shrink by that
picker's rows (`PickerHost`), and the ghost line gives way while the popup is
squeezed. Yoga does not
keep a nested minimum here, and OpenTUI draws a 0-row node as one row, so
the order is set by hiding whole boxes, not by shrink weights. A pane whose newest row matters
passes `stickToBottom` to `ChromePanel.Body` and puts its gaps above a row,
not under it.

The transcript pins the reader's last prompt in one row (`↑ <first line>`) above
the live tail while that prompt's own row is off screen: cut off the top of the
live viewport, or deep enough in native history that the terminal no longer
shows it (`promptOnScreen` in `message-list.tsx`, reckoned as if the row were
drawn so it never flickers). It is derived from the displayed items, so it
follows the branch and session in view. `readerPrompt` decides whose message
it is, from the metadata alone: a user message with the server's client origin
(`fromClient`: typed, or a steer that joined the running turn), or a custom
type whose `messageRendererContribution` passes `prompt` (the `/btw` fork's
question). A message another agent or an extension sent (a parent's
`Session.send`, a wake, a delegate start), a queued follow-up, a hidden message
and a row stored before the client origin existed are not. It is the first row a
short terminal gives up: it shows only while the live tail keeps a row beside
it. The expanded transcript and overlays pin nothing, and the terminal owns
scrollback, so there is no jump back to the original. The prompt is a memo of
the displayed items; a measurement only looks heights up by index and stops
summing once the answer is known, so per-frame work never grows with history.

## CLI Flags

| Flag             | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| `-p, --prompt`   | Initial message (goes straight to session view) |
| `-s, --session`  | Resume specific session ID                      |
| `-H, --headless` | Headless mode + prompt arg                      |
| `-a, --agent`    | Agent override for headless mode                |
| `--approve-all`  | Headless: approve every ask (default: decline)  |

`gent resume [session-id]` opens a stored session; with no id it opens the last
session in this directory.

Priority: headless → session → continue → prompt → home

A headless run has no user, so it declines every interaction its turn presents,
with notes that name `--approve-all`. `--approve-all` approves them all, the
destructive-command guard's asks included. The run follows only its own turn:
the live events from the `MessageReceived` of the prompt it sent (the first
client-sent user message with the prompt's text after the send) to the
`TurnCompleted` that names that message. A resumed session's history and an
older turn still running on the branch are not printed and do not settle it. An
`ErrorOccurred` alone does not end the run; the `TurnCompleted` receipt does.
It exits 1 when the receipt says `interrupted`, `streamFailed` or `unanswered`,
even after partial text, which has printed already. A receipt without those
flags (a historical one) exits 1 on an error with no answer text. An error
marked `notice: true` (a compaction fallback) is only a warning. The client
status also ignores a notice. A failed turn phase appends one `TurnCompleted`
with `streamFailed: true`, which settles the run; the send fails too, and
whichever comes first ends it. SIGINT exits 130 and SIGTERM 143. The run's end
owns stderr: a failed run prints one line, an answered run prints one
`Warning:` line for each notice.

## Input Prefixes

Special prefixes at input start trigger different modes:

| Prefix | Behavior                                      |
| ------ | --------------------------------------------- |
| `!`    | Shell mode - prompt changes to `$`, ESC exits |
| `$`    | Skills popup (scans ~/.claude/skills, etc.)   |
| `@`    | File finder popup, supports `@file.ts#10-20`  |
| `/`    | Command popup (/new, /agents, etc.)           |

### Shell Mode

- Type `!` at cursor position 0 → enters shell mode (prompt: `$`)
- Submit executes command, output shown in chat
- ESC or backspace at empty input exits shell mode
- Runs in the session's cwd; a spawn failure (the cwd is gone) is a refused submission (below)

### Refused submissions

- A submit leaves the composer before it is sent. A send the server refuses, a `!cmd` that cannot spawn, or a `/command` no command source names, comes back to the draft of the branch it was sent from, with its reason (`ComposerRefusals` in `session.tsx`)
- A `!cmd` that ran but whose output the server refused comes back as that output, a plain message, and the reason says the command ran. Enter sends the output; it never runs the command again. Once back it is an ordinary draft: an `@path` in it expands on that send, as in any draft
- A refused message as large as a paste (`isLargePaste`) comes back into the composer on screen as a paste placeholder; a kept draft of a branch the reader left holds the text itself, and a kept block that joins a composer on screen is written the same way. A refused command always comes back as its text, so the reader sees the command Enter would run
- A lost connection is not a refusal: the send may have landed. It retries four times under its first request id (`SEND_RETRY` in `utils.ts`, shared with the startup prompt and the headless send's predicate), and the text comes back only after the last try. That text keeps the request id: Enter on it unchanged sends it under the same id, so the server's dedup runs it once. An edited text, a draft that joins several refused texts, or a text the server answered goes under a new id. The `-p` startup prompt is a submission too: it is sent once, and a failed send comes back to the draft of its branch with its reason
- None is lost: refused texts come back in send order, ahead of what the reader has typed since. A draft of refused commands only stays in shell mode; a mixed draft writes each command with its `!`
- A refusal for a session the reader has left waits there: its text joins that branch's kept draft, and its reason (`client.setErrorIn`) shows when the reader returns. The session in view shows neither. A reason for the session in view shows at once. Every reason is held until a later error or a turn start replaces it, so each snapshot (which writes the error on screen: a return, a switch, a feed that hydrates again after a reconnect) shows it again. A turn that started while the connection was down arrives only inside a snapshot; the held reason remembers how many turns the branch had started when it showed, and a snapshot that counts more drops it. An error on screen never stops a running turn: the client keeps whether a turn runs apart from the error it shows, so Esc, Ctrl+C and an interjection act on the turn while an error shows
- Large output (>2000 lines or 50KB) truncated, full saved to `shell-output/` in the data directory (`GENT_DATA_DIR`, else `~/.gent`)

### File References

`@path/to/file.ts#10-20` expands to code block with lines 10-20 on submit,
resolved against the session's cwd. A path with whitespace or `#` is written
quoted, `@"my notes.md"#10-20`, and the popup inserts it that way. Punctuation
after a bare reference (`see @a.ts, then`) stays in the sentence. A file is cut
at 2000 lines or 50 KB of UTF-8, counted by the core line rule.

### Slash Commands

| Command            | Action                                                           |
| ------------------ | ---------------------------------------------------------------- |
| `/new`, `/clear`   | Start a new session                                              |
| `/sessions`        | Agents pane: every session, live and stored; side threads marked |
| `/agents`, `/tree` | Aliases of `/sessions`                                           |
| `/branch`          | Create new branch                                                |
| `/fork`            | Fork from a message                                              |
| `/thread`          | Thread pane: the sessions and windows this one runs on           |
| `/btw`, `/side`    | Fork pane: ask a parallel session on the side                    |

A command sent before every command source has answered (the client
extensions' load and the session's server slash list, `commandsSettled` in
`extensions/host.tsx`) waits for them, then resolves. Only then does an
unresolved command come back to its draft with `Unknown command: /x`. A
command still waiting when the session view goes comes back to its draft too.
The server list is read once per session and connection: a listing that a
dropped connection cut short is no answer, and the reconnect reads it again.

## Extensions

Every builtin without its own view lives in `src/extensions/builtins.tsx`; a
builtin that owns a view keeps its own `src/extensions/*.client.tsx` file:

| Extension ID                              | Where                    | What                                       |
| ----------------------------------------- | ------------------------ | ------------------------------------------ |
| `@gent/tools` / `@gent/interaction-tools` | `builtins.tsx`           | Tool renderers, interaction renderers      |
| `@gent/skills-ui`                         | `builtins.tsx`           | `$` autocomplete: skills popup             |
| `@gent/files-ui`                          | `builtins.tsx`           | `@` autocomplete: file search popup        |
| `@gent/driver-ui`                         | `builtins.tsx`           | `/driver` slash command                    |
| `@gent/goal`                              | `builtins.tsx`           | Goal label, goal continuation row          |
| `@gent/session-tools`                     | `builtins.tsx`           | Sender row for `session.send`              |
| `@gent/herdr`                             | `builtins.tsx`           | Herdr activity reporter                    |
| `@gent/agents-view`                       | `agents.client.tsx`      | Agents pane (the session browser), tray    |
| `@gent/btw`                               | `btw.client.tsx`         | `/btw` fork pane                           |
| `@gent/cache`                             | `cache.client.tsx`       | Cache-miss notice rows, cache waste total  |
| `@gent/delegate`                          | `delegate.client.tsx`    | `delegate.start` row, child-completion row |
| `@gent/thread-view`                       | `thread-view.client.tsx` | `/thread` pane                             |
| `@gent/wake`                              | `wake.client.tsx`        | Wake alarm tray, fired wake row            |

Client extensions author against one public entry, `@gent/tui/extensions`
(`src/extensions.ts`): `defineClientExtension`, `ClientContext`, the
contribution constructors, `sessionQuery` and the rendering kit. A shipped
client extension imports the TUI through that entry and nothing else, so a user
`*.client.ts(x)` file reaches everything a shipped one does; a loader test
fails on a shipped file that imports past it. A shipped client reads the
server extension it views through `@gent/extensions/client`, which the loader
binds for a user file too; a second loader test fails on a `@gent/*` import in
a shipped client that a user file cannot resolve. Only the builtin roster in
`builtins.tsx` names its sibling `*.client` modules.

Extension pipeline: `host.tsx` (static builtin imports) → `loader-boundary.ts`, which discovers, loads and resolves contributions

- Builtins are statically imported in `host.tsx` for Bun compiled binary compatibility
- User/project extensions discovered via filesystem scan (`loader-boundary.ts`, Effect-typed)
- `loader-boundary.ts` accepts `disabled` list — skips `setup` for disabled extensions
- One setup shape: Effect-typed `Effect<ClientContributions, E, R>`. Setups yield from the per-provider `clientRuntime` which provides `FileSystem | Path | ClientContext`. A setup yields the facets it needs: `const { transport, shell, lifecycle } = yield* ClientContext`. Never pass `ClientContext` or a facet as a parameter
- **Transport-only widgets**: there is no in-process snapshot cache. A widget reads server state through `sessionQuery` (in `client-facets.ts`), which yields `ClientContext`, keys each reply on `(sessionId, branchId)` and drops a reply for a session the shell has left. `follow: true` reads again on every session move. The widget refreshes it on typed session events or `transport.onExtensionStateChanged` pulses. The goal label (`builtins.tsx`) and the wake tray (`wake.client.tsx`) are the canonical examples.
- **Lifecycle**: register Solid `createRoot(dispose)` disposers AND pulse unsubscribes via `lifecycle.addCleanup`. The provider's `onCleanup` runs them in order on unmount, so widget setups leave no detached roots behind.
- Widgets are zero-prop components that read through `ClientContext`, never the host's Solid contexts (`useClient()`, `useExtensionUI()`). Host chrome that reads them (the connection and queue widgets) renders from `app.tsx`
- Extensions have no overlays. A pane is a `below-input` widget that renders while `shell.pane.isOpen(id)` is true. The extension opens and closes it by name with `shell.pane.open(id)` and `shell.pane.close(id)` (agents, thread, btw). The session view owns the one pane slot: it is the session overlay, shared with the model, reasoning, branch, fork-from-message and prompt-search pickers, so at most one pane is open. The boot branch picker and an enforced sign-in hold the slot: nothing opens over them until they close, and ctrl+c over them quits. Ctrl+C over any other session pane (model, reasoning, fork, prompt search) closes it as Esc does, and the next ctrl+c goes on down the ladder (draft, turn, quit). Opening a pane replaces the open one, and the replaced overlay's cancel runs in the reducer (`cancelOverlay` in `session.tsx`): prompt search gives the composer back the draft it opened over, and a late event from its list does nothing. `close(id)` of a pane that is no longer open does nothing. A pane does not hold the composer. A pane that takes typed text reads keys through `useScopedKeyboard`, as the agents filter and the btw ask line do: an `<input>` would take the terminal's focus from the composer, and the composer would not get it back. A key or paste a pane takes still reaches every `useInputWatch` watcher, which runs before the scopes and takes nothing; the session disarms its ctrl+c quit there.
- The TUI host (`src/` outside `extensions/`) never imports `@gent/extensions`; the `gent/core-entry-boundary` oxlint rule enforces it. One extension's view is a client extension that reads its server state through `ClientContext.transport`
- `useExtensionUI()` provides the resolved contributions (tool renderers excepted: `useToolRenderers()`), the load `failures`, and `clientRuntime`; widgets read the session from `transport.currentSession()`
- **Tool renderers**: `rendererContribution(toolNames, component)` keys a renderer on a real tool id. The model sees only `cell`, so the cell renderer hands each live op to the renderer registered for the op's tool (`RegisteredToolCall` in `tool-renderers.tsx`, the one lookup the transcript also uses). An op draws collapsed, as a sub-row with its own header: a cell that reads thirty files must not draw thirty file bodies. `ToolFrameBody` hides the header of one frame only; a frame nested in its body draws its header again. An op with no renderer keeps its one-line receipt. After a reload the session snapshot projects each cell's ops from the branch's stored tool events (`ToolInteraction.operations`), keyed by the cell's message and call id. A projected op carries only what its collapsed row draws, within one 8 KB encoded budget, keys included: the tool, the status, the summary, the scalar input fields (each whole or left out, up to 4 KB), and a bounded output (top-level scalars such as a bash `exitCode`; each string whole, or its head, a marker line and its tail, cut at code points). A cut string has a `cuts` record with its whole line count, the line its tail starts on, and whether its head or tail keeps only part of a line; renderers count and number lines through `outputRows` in `tool-renderers.tsx`, so a cut output draws true counts and line numbers, and marks a part of a line with `…` on the side it lost. A cut array (a grep's matches) draws its whole total and a `· ··· N more matches` gap between its head and tail. Every line count, the cut record's included, uses `lineCount` from `@gent/core/protocol`: a final newline ends the last line. A head or tail that keeps nothing is absent from the excerpt. It draws through its renderer again, with the same collapsed row as before the reload. A forked branch copies messages, not events, so there the saved result's receipts draw as lines. The host provides the map through `ToolRenderersProvider`. The "tool renderer reach" test in `loader-boundary.test.ts` fails on a renderer name that no shipped extension registers as a tool
- A setup that returns a key outside the contribution buckets fails to load with `unknown contribution "<key>"`
- **Message rows**: `messageRendererContribution(customType, component, { prompt? })` draws the user-role messages whose `metadata.customType` matches exactly. `prompt(content)` marks the type as a prompt the reader asked though an extension sent it, and gives its text; the transcript pins it (see the sticky prompt above). The component composes `UserRow` or `CollapsedRow` from `src/ui.tsx`. `message-list.tsx` names only the runtime's own kinds (`context-window`, `model-change`), and full detail draws every message as the plain row
- Status labels (`statusLabelContribution`) draw on the composer's one status row, after the host's labels and before the right-anchored context gauge and cost, ordered by `priority`. The row has no placement: a label that needs its own place is a widget
- **Notice rows**: `noticeRowContribution({ id, rows })` adds transcript rows that are not messages: nothing stores them and the model never reads them. `rows(session)` answers one branch's `NoticeRow`s (`key`, `createdAt`, one `glyph` drawn in `color`, muted `text`), or `None` while the source cannot yet say (native history commits nothing until every source answers, so a row is born with its final text; history holds for a source only `NOTICE_ROWS_BOUND` (5 s) after the extensions loaded, then commits without it; the source is no failure and stays, and a later answer draws its rows among those not yet committed); the session view merges them into the feed's rows by `createdAt` and draws each as the notice row. A higher scope's claim on an `id` replaces a lower one. An extension derives its rows from `transport.onSessionEvent`: the feed opens without waiting for extensions, and a subscriber that joins late first receives what the feed already delivered on the branch, then the live envelopes; a reconnect repeats envelope ids the subscriber must skip. `@gent/cache` is the example
- `transport.modelCatalog()` reads the model catalog the shell loaded for its model picker (prices included); it is reactive and `None` until the first load settles (a failed load settles empty)
- `autocompleteItems` contributions: extensions register prefix triggers + item sources for composer popups
- `workspace.cwd` / `workspace.home` for workspace-relative operations
- **`activity` has one encoding for absence**: `snapshot` is a plain reader, and a surface with nothing to report is given the default that returns `state: "unknown"` (a test takes it by omitting `activity`). Readers call `activity.snapshot()` and never re-test whether a provider exists — the composition root already decided. Do not reintroduce an `Option` around the reader alongside the default.

## Key Files (Composer + Session)

| File               | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `src/session.tsx`  | session-screen orchestration                     |
| `src/app.tsx`      | boot flow, session view, queue widget            |
| `src/composer.tsx` | composer render + wiring, popup, shell execution |
| `src/utils.ts`     | @file#line expansion                             |
| `src/commands.tsx` | Slash command handlers                           |
