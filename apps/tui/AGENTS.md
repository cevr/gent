# TUI Guidelines

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Source runs only: `apps/tui/bunfig.toml` declares `scripts/dev-preload-boundary.ts` for `bun` (top level) and `@opentui/solid/preload` for `bun test` (`[test]`); run from `apps/tui`. Binary doesn't need it. The source preload caches each `.tsx` transform under `$XDG_CACHE_HOME/gent/solid-transform/` (else `~/.cache`), keyed by `bun.lock` and the file's path and text, and loads Babel only on a miss: a warm launch reaches the first frame in about 1.1 s, a cold one in about 2.1 s.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.
- **autoloadBunfig: false** - Required in `Bun.build` compile options, else binary tries to load bunfig at runtime.
- **Message part types** - Import shared message, event, and RPC types from `@gent/core/protocol` when a UI projection needs them. Never redeclare.
- **render() is async** - Use `Effect.promise(() => render(...))`, not `Effect.sync`.
- **File naming** - All files kebab-case: `message-list.tsx`, `workspace.tsx`.
- **Error boundaries** - A failure travels in the Effect error channel and shows in the status row or the open pane's note row. No try/catch (`effect/noTryCatch`).
- **Exit pattern** - Exit through `useExit()` (`session.tsx`): it leaves the terminal through `leaveTerminal` (`message-list.tsx`: commit the live transcript tail with `flushTranscriptForExit`, then `renderer.destroy()`), then runs `useEnv().shutdown()`. SIGINT, SIGTERM and SIGHUP take the same path: the entry's hold on the renderer (`holdUntilRendererDestroyed`) runs `leaveTerminal` when it is interrupted, and the renderer leaves those signals to gent (`exitSignals` in `main.tsx`), so its own listener does not destroy it first. Never `process.exit()` — it bypasses Effect scope finalizers (server lock cleanup, SQLite WAL checkpoint).
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

## Clipboard

Every copy goes through `useClipboard` (`terminal.tsx`); do not add a second copy path. It writes OSC 52 with `renderer.copyToClipboardOSC52`: plain, which herdr, mosh (the `c` selector, at most 16 KiB of base64) and a local terminal take, even over ssh; OpenTUI wraps it in DCS for tmux and screen. tmux's defaults drop both forms, so inside tmux (`TMUX` set) it also runs `tmux load-buffer -w -`, as Codex does.

Who owns the mouse decides who copies a selection. In the split footer (the session view) `renderer.useMouse` is off: the terminal, or a multiplexer such as herdr or tmux, selects and copies itself. The expanded transcript, the palette and every overlay that holds the composer (`overlayHoldsComposer`: the sign-in pane, the model and branch pickers) turn it on, so OpenTUI draws the selection and the terminal never sees the drag. There `useCopyOnSelect` (mounted once in `AppContent`) copies a finished, non-empty selection. The sign-in pane also copies its URL whole on `ctrl+y` (a non-printing key, so a code typed by hand keeps every letter); its note row says the URL was copied when tmux took it (inside tmux, where a sent OSC 52 proves nothing) or OSC 52 was sent (outside tmux), and otherwise "Could not reach the clipboard — select the URL instead". A test reads the bytes by rendering with `output: new TerminalOutput()` (`render-harness-boundary.tsx`).

## Theme System

Ported from opencode. Key patterns:

- `renderer.getPalette({ size: 16 })` queries terminal's ANSI palette via OSC
- System theme generated from terminal colors; fallback to the `fx` theme
- JSON themes in `src/themes/*.json` with `defs` + dark/light variants
- `resolveTheme(themeJson, mode)` resolves refs to RGBA values
- The palette's "Theme" level enumerates `all()`; "Mode" is the separate Dark/Light toggle. A ported theme may omit `selectedListItemText`/`backgroundMenu`; `resolveTheme` supplies both.

## Command Palette

- `Ctrl+P` or `/help` opens palette
- One `Command` shape (`id`, `title`, `category`, optional `keybind`, `slash`, `aliases`, `onSelect`, `onSlash`) and one resolved list, `useExtensionUI().commands()`. The palette search matches a command's title, its slash name and aliases, its description and its category, so `frecency` finds "Reset Autocomplete Ranking". One leading "/" in the query is dropped, so `/clear` finds "New Session" as `clear` does
- A keybind with no ctrl or meta (a bare key such as `left`) is a key the composer also reads, so it fires only while the composer is idle: an empty draft in editing mode, no overlay or docked pane, no interaction, the transcript collapsed (`composerIdle` in `session.tsx`). Any extension can bind one to a key that types nothing (an arrow, a function key). A bare key that types a character (`j`, `?`, `shift+j`, `space`) would take the first character of every message: `resolveCommands` refuses that keybind in every scope and lists it with the failed extensions; the command keeps its slash and palette row. A bare `escape` and a `ctrl+c` (with or without shift) are refused the same way (`REFUSED_KEYBINDS` in `loader-boundary.ts`): keybinds run before the Esc and ctrl+c ladders, so either would take the pane close, the turn cancel and the exit. `←` opens the agents pane this way; in the pane `←` or Esc closes it and `→` or Enter switches to the row, as `←`/`→` move between palette levels
- `resolveCommands` merges the session's own commands (`setSessionCommands`, builtin scope), client extension commands, and server slash commands (builtin scope). Precedence is project > user > builtin; a higher scope takes a slash or keybind from the earlier owner, and a same-scope claim is dropped and listed with the failed extensions

## Keys: the exit and cancel ladder

One ladder, owned by `createSessionController` (`handleEscape`, `handleInterrupt` in `session.tsx`). Esc never quits.

- **Esc** clears a list's filter before leaving the list. On a sign-in screen it goes back to the provider's methods, then the provider list. In the session it closes the palette, collapses the expanded transcript, collapses the disclosure, then cancels a running turn. On a draft the first press arms and the status row says `esc again to clear`; the second clears the draft. On an empty idle composer it does nothing. In shell mode a draft arms and clears the same way; on an empty shell draft the composer takes Esc and leaves shell mode.
- **ctrl+c** closes a pane that holds the composer, closes the palette, collapses the expanded transcript, clears a draft, stops a running `!cmd` (and arms nothing), then cancels a running turn. A press that cancels a turn, or one on an idle empty composer, arms the exit and the status row says `ctrl+c again to exit`; the second press exits, even over a turn that started since (children that keep waking the session).
- **ctrl+w**, **alt+backspace**, **ctrl+backspace** and **ctrl+u** in a list's filter, on an extension's ask line (the `/btw` pane) and on the sign-in key line delete the last word (the first three) and the whole line, as they do in the composer. They take their edit keys from `eraseKey` and `lineEdit` (`ui.tsx`, `lineEdit` exported to client extensions).
- **ctrl+d** on an empty composer exits (no pane, palette or ask open, the transcript collapsed); on a draft it deletes forward.
- An armed key disarms on any other key (the other ladder key included: an Esc that leaves shell mode disarms a ctrl+c), a paste, a keybind, or after one second (a fiber on the client runtime, so a test clock moves it; the view interrupts it when it unmounts). The arm is per key: a ctrl+c then an Esc is two gestures.
- Over the boot branch picker and an enforced sign-in, Esc does nothing and the hint says `ctrl+c quit`; ctrl+c arms the exit as on an empty composer, and the second press exits.

## Error Handling

- A failure is a typed error in the Effect channel; a Promise boundary enters through `Effect.tryPromise` with a tagged error. No try/catch (`effect/noTryCatch`)
- Show it in the status row or in the open pane's note row; never crash the TUI

## Debugging

- Debug output goes to `clientLog` (`client.tsx`), which writes JSON lines to `<data dir>/logs/<hash>-<ts>-client.log`. `console` is banned (`effect/noGlobals`): it would draw over the TUI

## Architecture

Startup blocks before render — `main.tsx` calls `waitForReady` + `resolveInteractiveBootstrap` before `render()`. No loading route.

Providers wrap app in `main.tsx`:

```
EnvProvider → WorkspaceProvider → ClientProvider → ExtensionUIProvider → TerminalDimensionsProvider → SpinnerClockProvider → ComposerMemoryProvider → App
```

| Provider                     | Purpose                                             |
| ---------------------------- | --------------------------------------------------- |
| `EnvProvider`                | `$VISUAL`/`$EDITOR`, graceful `shutdown`            |
| `WorkspaceProvider`          | cwd, gitRoot, gitStatus - static workspace info     |
| `ClientProvider`             | transport client, session state, event stream       |
| `ExtensionUIProvider`        | extension loading, command list, composer dispatch  |
| `TerminalDimensionsProvider` | terminal width and height, one reactive reader      |
| `SpinnerClockProvider`       | the one 60 ms clock spinners and retry rows read    |
| `ComposerMemoryProvider`     | drafts, refusals, prompt history, startup prompt    |
| `SessionControllerContext`   | session-scoped: auth gate, overlays, composer state |

State ownership rules:

- One workflow, one owner. If a flow has modes/transitions, give it one reducer or machine.
- Shared caches live under a provider/registry scope, not module globals.
- Projections stay local and dumb. Do not promote derived display state into a second writer.
- Render-local view unions in `src/` are Schema unions too (`effect/preferSchemaTaggedUnion` reads every tag spelling): `Schema.TaggedStruct` variants with `Schema.toTaggedUnion("_tag")` for a lowercase or kebab-case tag. Test the tag with `_tag ===` on a value whose payload holds class instances; `.guards` runs the full schema check.
- Auth is a view (`auth.tsx`); when the session controller's auth gate detects missing required providers it docks in the footer like every pane, one `PickerFrame` per screen (provider list, methods, the key line, the OAuth wait).
- There is no router. `client.session()` says which session shows, `switchSession` is its one writer, and `App` keys the session mount on it.
- `useRuntime()` is zero-arg — reads `useClient()` internally.
- Composer reads from `SessionControllerContext`, not props.

Views (only 1):

- `src/app.tsx` — the boot flow and the session view; provides
  `SessionControllerContext`
- `src/session.tsx` — `createSessionController()` + context

The branch picker is a docked pane (`pickers.tsx`), not a
view. It draws `PickerFrame` like every other docked pane. The boot flow opens it over the mounted session when the resumed session
has more than one branch. No branch is chosen yet, so there is nothing behind it
to fall back to: Esc does nothing there, and its hint says `ctrl+c quit`. The
command palette's "Branches" level switches branches after that.

Every docked pane docks in one slot: under the status row, which sits right
under the input (`StatusRow`, placed by `Composer`). The slash popup and the
palette dock inside the composer after it; the model, effort, branch, fork,
prompt-search and sign-in panes and the extension panes dock after the
composer. The status row never moves when a pane opens. Every pane's key-hint
row is data: `PickerFrame` takes `keys` and draws them in one vocabulary
(`KeyHints` and `keyHintsLine` in `ui.tsx`, also exported to client
extensions): lowercase keys, one `·` separator, Enter `select` on a row and
`submit` on typed text, Esc `close` on a pane and `back` on a sub-screen. A
narrow row drops the move hint first, then hints from the right, and keeps the
way out. An ask's footer uses the same line.

The footer (composer, trays, docked panes) never outgrows the split-footer
region (`DockFooter`'s `maxHeight` in `app.tsx`). While a docked pane is open
the trays hide (`TrayFrame` reads the `DockProvider` count each `PickerFrame`
adds to), so the pane the reader opened gets the rows. The footer's blank
rows (above the activity row, above the input, above the status row) and the
composer's ghost line are dock spacers (`useDockSpacer`): they give way when a
docked frame is squeezed, and come back only once the footer's free rows
(`DockFooter` reports them) hold them all, so the give-way never flickers.
With no pane open they never give way. A list pane passes no size: its
`SelectList` reports the lines it draws (headings included) and its filter or
query row, and the frame adds its chrome and its note row and caps the sum
(`pickerHeight`: four rows of chrome, six body lines at most; the query row
sits outside the cap). A pane that is not a list (the btw transcript, the
sign-in key and OAuth screens) asks for a `height` outright. The note row is
the pane's `detail` line, or its `error`
in the detail's place: a pane with a detail line keeps the row while the
detail is `None`, so it does not jump when the text arrives. The pane is
then the one box that gives way, in whole rows (`PickerFrame` sets a
`flexBasis`, not a `height`: OpenTUI turns shrinking off on a box whose
height is set); squeezed, it drops its key hint, then its title, before a
row its body requires (a list's cursor row; the sign-in OAuth screen's URL
and code, which also outrank its optional code line). Inside the body the order goes on: the note row gives way
first, then the `SelectList` headings, then its filter row, and one row stays
for the cursor (the list reads its rows from the frame). Under three rows
the frame drops its rules and note row too, so its one or two rows go to
the list. With a turn running, a terminal under 6 rows leaves a pane no
row (8 rows leave it 3, 7 leave 2, 6 leave 1): the frame then draws nothing, and a `KeyboardGate` keeps its scopes
from taking keys (register a pane's key scope inside its frame, so the gate
covers it). Keys go past it; Esc still closes it, an extension pane included, and never cancels the turn behind it (the boot branch picker and an enforced sign-in are exempt: Esc does nothing over them, with a row or without, since closing them would skip the choice they hold, and Ctrl+C quits). The frame
reads its rows from the Yoga layout before each draw, because OpenTUI reports
a 0-row box as one row and sends no size change between them. A pane that draws
its own query line (the autocomplete popup, the command palette) passes it as
the list's `queryRow`, so it gives way as the filter row does. The composer
keeps its rows, but while its popup or palette is open it may shrink by that
picker's rows (`PickerHost`). The live transcript tail, left no row by a
full footer, hides whole (`NativeTranscript` reads its rows as the frame
does), so it never draws over the footer's first row; so does a
`ChromePanel.Body` left no row (its content hides), so it never draws over
the btw ask line or the sign-in code line. Yoga does not
keep a nested minimum here, and OpenTUI draws a 0-row node as one row, so
the order is set by hiding whole boxes, not by shrink weights. A pane whose newest row matters
passes `stickToBottom` to `ChromePanel.Body` and puts its gaps above a row,
not under it.

The split region is a canvas: the footer's base (composer, status row, the
activity row while it carries content) and the live tail, the transcript's
last rows. OpenTUI draws only the region, and a region that grows at the
terminal's bottom pushes rows into scrollback that cannot come back, so
growing UI never grows it: the suggestions and the docked panes cover the
tail's last rows, and the footer's base stays as it was while one is open
(`paneOpen`, from `useDockPaneOpen` in `ui.tsx`). The tail keeps the rows the
region shows at the smallest base since the last replay (`footerFloor`), so
the activity row going at a turn's end shows kept rows, not blank ones; rows
the tail does not fill sit above it, never above the composer. The rows above
the canvas go to native history in order: during a turn only whole final
items (`isFinalItem` in `message-list.tsx`: a streamed `draft` answer waits
for its stored answer, a message waits while a call of it runs, and the head
of a tool run waits until the run ends); at idle
an item's top rows too (`partialRows`; the live view cuts them off), so each
row is in history or on screen, once. A commit shrinks the region by its rows
first and then writes them, so they land where they were drawn; a write
OpenTUI refuses, or rows drawn from an item that changed while they settled
(`stillOffered`), give the rows back to the live view; an item that changes
after history took its top rows replays the transcript. A region above the
bottom (a short session) shrinks to what it wants. A test that needs an item
in history puts a long answer after it. Transcript rows keep the terminal's
last column free (`FREE_LAST_COLUMN`): OpenTUI erases to the line's end after
a committed row, which takes a full-width row's last cell (a table's right
border). A whole item whose highlight does not settle, and every whole item
at exit, commits as plain text (`PlainHistoryContext`); the plain layout has
other rows, so rows of an item the live view shows in part commit as drawn. Closing the palette or a
picker replays nothing, so the shell's lines above gent stay. The region
takes back the rows it left, and after the return's first frame
(`afterReturnFrame`) the rows the footer and the tail want: the tail keeps its
measure behind an overlay, so a turn that ended there shows its last rows.
The return sets no cursor and resets nothing: patched OpenTUI keeps the
split's row and the last history row's end column across the alternate
screen (`patches/README.md`), so the next commit starts under that row. A replay (a
resize, a disclosure change, an item changed in history, `/clear`, another
session or branch) writes history again, so its reset clears the terminal's
saved lines first (`resetHistory`): the old copy would show each row twice.
Exit commits the live tail first (`leaveTerminal`; over the palette, a pane
that holds the composer or the expanded transcript it takes the terminal's
screen back first, as scrollback takes no rows from the alternate one), and the renderer is
created with `clearOnShutdown: false`, so exit leaves every turn on screen.

Answer markdown draws each top-level block on its own
(`internalBlockMode="top-level"`), so a heading never shows its `#` marks
before its highlight lands. Answer tables keep a grid, fit their content
within the answer and pad each cell by one column (`ANSWER_TABLE`).
A ` ```mermaid ` fence is its own block,
drawn by `useDiagramCodeBlocks` (`mermaid.ts`; beautiful-mermaid loads on
the first fence, and history waits for the load to end; a failed load
shows the fence as code): compact boxes in theme colors, no wrap, no
selection, at most 120 columns (a wider diagram is cut). While the fence
streams it draws each statement once it ends (a newline, or a `;` outside a
label) and keeps its last diagram when they do not draw; once closed, a
source that does not draw shows as its code block. Tests give their own
library through `DiagramLibraryContext`.

A tool group reads in tool words, as fx does, not in the cell mechanism
(`ToolCallGroup` in `message-list.tsx`, the projections in `utils.ts`). Its
header counts the tools a group ran (a cell's ops; any other call is the one
tool it is; a cell with no ops is one tool that names its source's verbs) by
kind, largest first, then the reasoning the run took as thoughts:
`● 7 tools · 4 read · 2 edit · 1 command · 6 thoughts · 1 failed · 4.2s`
(`formatActivityHeader`). An MCP tool (`mcp.<server>.<tool>`) counts as its
server (`2 linear`) and its rows read `Called linear.list_issues …`. A narrow
header drops the thoughts first, then kinds from the right, and keeps the
count, the failures and the time. The glyph is `●` when done, the pulse
while a call runs, `✗` in the error colour when a call failed, and `●` in the
warning colour when only ops failed inside a cell that recovered. A bash op
whose command exits nonzero is a failed op, as fx counts it, though its call
succeeded (`callOperation`).

The `ctrl+o` ladder (`DisclosureLevel` in `extensions/client-facets.ts`) keeps
three levels for every block, as opencode's web app folds tool calls to one
line and fx draws them as a tree. Collapsed (the default) is one head line a
block, plus one line a failure, so a failure shows at every level. Preview is
the tree: one line a child. Full opens the bodies. `esc` collapses.

- **Tool group.** Collapsed draws the header and, under it, one row for each
  failed call or op (`failedOperations`, `formatFailureRow`):
  `└ Ran ls d.ts · exit 2 · ls: cannot access …`. The row keeps the verb, the
  subject and the outcome word, and cuts the reason first; the reason drops
  the runner's `Tool '<name>' failed:` lead. Preview draws one row per run of
  one tool and one outcome, in past-tense words (`activityRows`,
  `formatActivityRow`): `├ Read a.ts, b.ts +1` (the subjects that fit, then a
  count), `├ Edited x.ts +12 / -3` (the diff counts in the success and error
  colours), `└ Ran bun test · exit 1`, and the running op last as
  `Running …`. A failed op never folds: each has its own row. A failed cell
  adds its own row unless its error text is an op's error text. A cut call
  (the turn's interrupt, `reason: "Interrupted"`, or the cell's cancel, a
  `CellKernelError` whose reason is `cancelled`; `cutShort`) is no failure:
  the op it cut reads `└ Ran sleep 20 · cancelled` in the warning colour, the
  cell adds no row of its own, and the header counts `1 cancelled`. Under a failed
  row, and under the run's last command row, preview draws up to five rows of
  that op's own output (`outputHead`: a command's stdout and stderr, a failed
  call's reason; never the cell's display) behind a `│ ` gutter, then
  `│ … +N lines (ctrl+o)`. The last command's head waits for the run's end:
  while a turn can still add a step, the last command changes each step, and
  a head that came and went would shrink the live tail and leave blank rows
  in native scrollback. A failed op has settled, so its head draws at once.
  Full opens a row per call with its renderer body and its line counts; only
  there does a call show its `#id`. Inside a cell's body a run of one tool's
  ops folds into one frame (`read 30 files`), its body a tight list; the
  transcript view (full detail) draws every op on its own
  (`FoldOperationsProvider`). An edit's collapsed body draws its hunks only
  (`diffHunkLines`: no `Index:`/`===`/`---`/`+++` preamble).
- **Reasoning.** A run takes the reasoning just before its first call (from
  that call's own message only: an earlier message may already be in
  history), the reasoning between its calls, and the reasoning just before the
  answer text that ends it; the header counts each as a thought, and full
  draws each where it came. Reasoning with no run is one line at collapsed and
  preview, `∴ Thought · <first summary> · N summaries`, and its markdown at
  full and in the transcript view.
- **Child completion** (`delegate.client.tsx`). Collapsed is one line,
  `✓ explore completed · 9f3a2c1d · 14 tools · ↑1.2k ↓300 $0.01`, with a
  failed child's error last; narrow, the error is cut first, then the usage
  drops, then the call count. Preview adds the child's last five calls as
  tree rows (`├ … 9 earlier calls`) and a five-line head of its answer. Full
  draws every call the details kept and the whole answer. It draws no user
  rail: it is a tree node like a tool group.
- **Connection notice** (`ConnectionWidget` in `app.tsx`). Collapsed is one
  line that counts the issues (`• connection · 6 model catalogs unavailable ·
ctrl+o`), with a tree row for each failed extension; preview and full list
  every issue on its own row. It is in the live tail, so a level change costs
  no replay.
- **Session error.** Below full, an error over four lines shows four, then
  `… +N lines (ctrl+o)`.
- **Activity row.** A running call reads in the words its row will use once
  it ends (`formatRunningCall`): `Running mkdir -p x`, `Reading src/app.tsx`,
  `Calling linear.list_issues team=core`.

A `ToolFrame` draws its `▸`/`▾` mark and takes a click only inside
`FrameClicks on` (`ui.tsx`), which `NativeTranscript` sets in the transcript
view, where the mouse is on. Inline the mouse is off and the wheel scrolls
the terminal, so a mark there would promise a click that never comes. The
transcript view opens over frames already mounted inline, so the context
holds an accessor that the mark and the click handler read; a change of it
puts each frame back to its owner's form.

A group is one run of tool calls across the steps of a turn, as in fx
(`projectToolRuns` in `message-list.tsx`): reasoning and blank text between
calls do not end it; answer text, a user message, a session row, or a call
that asks the reader (`ask_user`, `prompt`, `handoff`, in a cell's ops too)
does. A queued follow-up and a pending retry end nothing. The run draws at its
first tool-call segment (its head); the later steps skip the segments it took.
The reasoning it took draws where it came at the full level only; a closing
thought from a streamed answer keeps the head waiting for the stored answer. The
native transcript draws each item on its own, so it projects the runs once over
every displayed item and gives them to the live view and to each history
surface (`ToolRunsContext`). A message that heads a run is final only once the
run has ended, holds no streamed step and no running call; its fingerprint
holds the run's calls and thoughts (`historyFingerprints`), so a run that grows after
history took its top rows at idle replays history. The transcript view (full
detail) groups each message's calls on their own.

The transcript pins the reader's last prompt in one row (`↑ <first line>`) above
the live tail while that prompt's own row is off screen: cut off the top of the
live viewport, or deep enough in native history that the terminal no longer
shows it (`promptOnScreen` in `message-list.tsx`, reckoned as if the row were
drawn so it never flickers). It draws only while a turn runs, and not while
history holds the top rows of the first live item (`partialRows`): at idle
history takes them, and they stay there into the next turn until the item
moves whole, so the row would sit between that item's rows in history and its
rows on screen. It is derived from the displayed items, so it
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
with notes that name `--approve-all`. `--approve-all` approves every ask. The
run follows only its own turn: the live events from the `MessageReceived` of
the prompt it sent (the message its send's request id names, through
`userMessageIdForRequest`) to the `TurnCompleted` that names that message.
Another client's message with the same text is not the run's. A resumed
session's history and an
older turn still running on the branch are not printed and do not settle it. An
`ErrorOccurred` alone does not end the run; the `TurnCompleted` receipt does.
It exits 1 when the receipt says `interrupted`, `streamFailed` or `unanswered`,
even after partial text, which has printed already. A receipt without those
flags (a historical one) exits 1 on an error with no answer text. An error
marked `notice: true` (a compaction fallback) is only a warning. The client
status also ignores a notice. A failed turn phase appends one `TurnCompleted`
with `streamFailed: true`, which settles the run; the send fails too, and
whichever comes first ends it. SIGHUP exits 129, SIGINT 130 and SIGTERM 143. The run's end
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
- ESC at an empty shell draft, or Backspace at the draft's start (it stands for deleting the `!`), exits shell mode; Backspace elsewhere edits the command; ESC on a shell draft arms its clear (see Keys)
- Runs in the session's cwd; a spawn failure (the cwd is gone) is a refused submission (below)
- Has no time limit: while it runs the activity row shows `$ cmd`, and ctrl+c stops it (or the view going). A stopped command sends nothing, and the status row says so
- Output is read as it arrives, up to 8 MiB (`SHELL_READ_CAP_BYTES` in `composer.tsx`); past that the command is ended. The message keeps the lines that fit the `@file` cap; a cut writes the output read to `<data dir>/shell-output/` and the message names the file
- A command that exits with a status other than zero ends its message with `[exit N]`, so a failure that prints nothing still reads as one

### Refused submissions

- A submit leaves the composer before it is sent. A send the server refuses, a `!cmd` that cannot spawn, or a `/command` still waiting for the command sources when the view goes, comes back to the draft of the branch it was sent from, with its reason (`ComposerRefusals` in `session.tsx`)
- A `!cmd` that ran but whose output the server refused comes back as that output, a plain message, and the reason says the command ran. Enter sends the output; it never runs the command again. Once back it is an ordinary draft: an `@path` in it expands on that send, as in any draft
- A refused message as large as a paste (`isLargePaste`) comes back into the composer on screen as a paste placeholder; a kept draft of a branch the reader left holds the text itself, and a kept block that joins a composer on screen is written the same way. A refused command always comes back as its text, so the reader sees the command Enter would run
- A lost connection is not a refusal: the send may have landed. It retries four times under its first request id (`SEND_RETRY` in `utils.ts`, shared with the startup prompt and the headless send's predicate), and the text comes back only after the last try. That text keeps the request id: Enter on it unchanged sends it under the same id, so the server's dedup runs it once. An edited text, a draft that joins several refused texts, or a text the server answered goes under a new id. The `-p` startup prompt is a submission too: it is sent once, and a failed send comes back to the draft of its branch with its reason
- None is lost: refused texts come back in send order, ahead of what the reader has typed since. A draft of refused commands only stays in shell mode; a mixed draft writes each command with its `!`
- A refusal for a session the reader has left waits there: its text joins that branch's kept draft, and its reason (`client.setErrorIn`) shows when the reader returns. The session in view shows neither. A reason for the session in view shows at once. The reason stands while its restored draft stays unchanged; an edit dismisses that reason and keeps a newer error. Until then, each snapshot (a return, a switch, or a feed that hydrates after a reconnect) shows the held reason again. A later error or a turn start replaces it. A turn that started while the connection was down arrives only inside a snapshot; the held reason remembers how many turns the branch had started when it showed, and a snapshot that counts more drops it. An error on screen never stops a running turn: the client keeps whether a turn runs apart from the error it shows, so Esc, Ctrl+C and an interjection act on the turn while an error shows

### File References

`@path/to/file.ts#10-20` expands to code block with lines 10-20 on submit,
resolved against the session's cwd. A path with whitespace or `#` is written
quoted, `@"my notes.md"#10-20`, and the popup inserts it that way. Punctuation
after a bare reference (`see @a.ts, then`) stays in the sentence. A file is cut
at 2000 lines or 50 KB of UTF-8, counted by the core line rule.

### Slash Commands

| Command            | Action                                                             |
| ------------------ | ------------------------------------------------------------------ |
| `/new`, `/clear`   | Start a new session                                                |
| `/help`            | Open the command palette                                           |
| `/sessions`        | Sessions pane: every session, live and stored; side threads marked |
| `/agents`, `/tree` | Aliases of `/sessions`                                             |
| `/branch`          | Create new branch                                                  |
| `/fork`            | Fork from a message                                                |
| `/thread`          | Thread pane: the sessions and windows this one runs on             |
| `/btw`, `/side`    | Fork pane: ask a parallel session on the side                      |

A command sent before every command source has answered (the client
extensions' load and the session's server slash list, `commandsSettled` in
`extensions/host.tsx`) waits for them, then resolves. Only a known command
name is a command, and the session decides which names are known. A name
the settled sources lack makes the session read the server list once more
(`refreshCommands`), since an extension can register a command after the
last listing. A first word that still names no command is refused into its
draft, `Unknown command: /zzq · ctrl+p commands`, unless it reads as a path
(a second `/` or a `.`): that line goes out as a message. A draft that starts
with a paste chip is never a command. A command still waiting when the
session view goes comes back to its draft too. The server list is read once
per session and connection and on each refresh: a listing that a dropped
connection cut short is no answer, and the reconnect reads it again.

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
| `@gent/cache`                             | `cache.client.tsx`       | Cache-miss rows, waste total, cache timer  |
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
- One setup shape: Effect-typed `Effect<ClientContributions, E, R>`. Setups yield from the per-provider `clientRuntime` which provides `FileSystem | Path | ChildProcessSpawner | ClientContext`. A setup yields the facets it needs: `const { transport, shell, lifecycle } = yield* ClientContext`. Never pass `ClientContext` or a facet as a parameter
- **Transport-only widgets**: there is no in-process snapshot cache. A widget reads server state through `sessionQuery` (in `client-facets.ts`), which yields `ClientContext`, keys each reply on `(sessionId, branchId)` and drops a reply for a session the shell has left. `follow: true` reads again on every session move. The widget refreshes it on typed session events or `transport.onExtensionStateChanged` pulses. The goal label (`builtins.tsx`) and the wake tray (`wake.client.tsx`) are the canonical examples.
- **Lifecycle**: register Solid `createRoot(dispose)` disposers AND pulse unsubscribes via `lifecycle.addCleanup`. The provider's `onCleanup` runs them in order on unmount, so widget setups leave no detached roots behind.
- Widgets are zero-prop components that read through `ClientContext`, never the host's Solid contexts (`useClient()`, `useExtensionUI()`). Host chrome that reads them (the connection and queue widgets) renders from `app.tsx`
- Extensions have no overlays. A pane is a `below-input` widget that renders while `shell.pane.isOpen(id)` is true. The extension opens and closes it by name with `shell.pane.open(id)` and `shell.pane.close(id)` (agents, thread, btw). The session view owns the one pane slot: it is the session overlay, shared with the model, effort, branch, fork-from-message, prompt-search and sign-in panes, so at most one pane is open. The boot branch picker and an enforced sign-in hold the slot: nothing opens over them until they close, Esc does nothing over them, and ctrl+c over them arms the exit (the second press quits). Ctrl+C over any other session pane (model, effort, fork, prompt search) closes it as Esc does, and the next ctrl+c goes on down the ladder (see Keys). Opening a pane replaces the open one, and the replaced overlay's cancel runs in the reducer (`cancelOverlay` in `session.tsx`): prompt search gives the composer back the draft it opened over, and a late event from its list does nothing. `close(id)` of a pane that is no longer open does nothing. A pane does not hold the composer. A pane that takes typed text reads keys through `useScopedKeyboard`, as the agents filter, the btw ask line and the sign-in key line do: an `<input>` would take the terminal's focus from the composer, and the composer would not get it back. A key or paste a pane takes still reaches every `useInputWatch` watcher, which runs before the scopes and takes nothing; the session disarms an armed key there.
- The TUI host (`src/` outside `extensions/`) never imports `@gent/extensions`; the `gent/core-entry-boundary` oxlint rule enforces it. One extension's view is a client extension that reads its server state through `ClientContext.transport`
- `useExtensionUI()` provides the resolved contributions (tool renderers excepted: `useToolRenderers()`), the load `failures`, and `clientRuntime`; widgets read the session from `transport.currentSession()`
- **Tool renderers**: `rendererContribution(toolNames, component)` keys a renderer on a real tool id. The model sees only `cell`, so the cell renderer hands each live op to the renderer registered for the op's tool (`RegisteredToolCall` in `tool-renderers.tsx`, the one lookup the transcript also uses). An op draws collapsed, as a sub-row with its own header: a cell that reads thirty files must not draw thirty file bodies, and outside the transcript view consecutive ops of one tool fold into one frame. `ToolFrameBody` hides the header of one frame only; a frame nested in its body draws its header again. An op with no renderer keeps its one-line receipt. After a reload the session snapshot projects each cell's ops from the branch's stored tool events (`ToolInteraction.operations`), keyed by the cell's message and call id. A projected op carries only what its collapsed row draws, within one 8 KB encoded budget, keys included: the tool, the status, the summary, the scalar input fields (each whole or left out, up to 4 KB), and a bounded output (top-level scalars such as a bash `exitCode`; each string whole, or its head, a marker line and its tail, cut at code points). A cut string has a `cuts` record with its whole line count, the line its tail starts on, and whether its head or tail keeps only part of a line; renderers count and number lines through `outputRows` in `tool-renderers.tsx`, so a cut output draws true counts and line numbers, and marks a part of a line with `…` on the side it lost. A cut array (a grep's matches) draws its whole total and a `· ··· N more matches` gap between its head and tail. Every line count, the cut record's included, uses `lineCount` from `@gent/core/protocol`: a final newline ends the last line. A head or tail that keeps nothing is absent from the excerpt. It draws through its renderer again, with the same collapsed row as before the reload. A forked branch copies messages, not events, so there the saved result's receipts draw as lines. The host provides the map through `ToolRenderersProvider`. The "tool renderer reach" test in `loader-boundary.test.ts` fails on a renderer name that no shipped extension registers as a tool
- A setup that returns a key outside the contribution buckets fails to load with `unknown contribution "<key>"`
- **Message rows**: `messageRendererContribution(customType, component, { prompt? })` draws the user-role messages whose `metadata.customType` matches exactly. Its props carry the transcript's `disclosure`, so a row folds with `ctrl+o` like every other block (the child completion row does). `prompt(content)` marks the type as a prompt the reader asked though an extension sent it, and gives its text; the transcript pins it (see the sticky prompt above). The component composes `UserRow` or `CollapsedRow` from `src/ui.tsx`. `message-list.tsx` names only the runtime's own kinds (`context-window`, `model-change`), and full detail draws every message as the plain row
- Status labels (`statusLabelContribution`) draw on the composer's one status row, ordered by `priority`: in the left group after the host's labels, or, with `anchor: "right"`, in the right group before the context gauge and cost. The right group is laid out first and keeps its place on a narrow row. A label, a host's or an extension's, may give a short form (`StatusRowLabel.short`, `StatusLabelItem.short`, ranked by `STATUS_YIELD`): a group that cannot fit its labels in full takes short forms in rank order (the debug mark, the cwd, the model as `Auto → Sonnet 5`, the idle phase word, the effort as `auto→high`), then gives back each full form that fits again (`fitForms` in `composer.tsx`); what still does not fit truncates. The ranks are an order, not widths: an extension label ranks between two host labels with a fraction (`STATUS_YIELD.cwd + 0.5` gives way after the cwd and before the model). A glance number anchors right (the `@gent/cache` timer); a label that needs more than one row is a widget
- `transport.selectedModel()` is the model the session in view runs next, as the status row names it: a model switch changes it before any request goes out
- The status row's effort is the running turn's while a turn runs (`turnReasoningLevel` in `client.tsx`, from the metrics fold's `turnEffort`), and the session's next level (`reasoningLevel`) otherwise: a turn keeps its first step's level, so an `/effort` change shows once the turn completes. On `/effort auto` (`reasoningAuto` in `client.tsx`) the row reads `auto → <level>` with the newest effort route's level (the fold's `effortRouted`), and `auto` before the first route. The effort picker reads the session's setting, and marks its `auto` row (`AUTO_ROW_ID` in `pickers.tsx`, listed after `default` when the model takes any level) while the session is on auto; after an effort route that fell back (`effortFallback` in `client.tsx`, the fold's `effortRouted.fallback`) the `auto` row reads `routes fall back: <reason>`
- **Notice rows**: `noticeRowContribution({ id, rows })` adds transcript rows that are not messages: nothing stores them and the model never reads them. `rows(session)` answers one branch's `NoticeRow`s (`key`, `createdAt`, one `glyph` drawn in `color`, muted `text`), or `None` while the source cannot yet say (native history commits nothing until every source answers, so a row is born with its final text; history holds for a source only `NOTICE_ROWS_BOUND` (5 s) after the extensions loaded, then commits without it; the source is no failure and stays, and a later answer draws its rows among those not yet committed); the session view merges them into the feed's rows by `createdAt` and draws each as the notice row. A higher scope's claim on an `id` replaces a lower one. An extension derives its rows from `transport.onSessionEvent`: the feed opens without waiting for extensions, and a subscriber that joins late first receives what the feed already delivered on the branch, then the live envelopes; a reconnect repeats envelope ids the subscriber must skip. `@gent/cache` is the example
- `transport.modelCatalog()` reads the model catalog the shell loaded for its model picker (prices included); it is the session in view's own catalog, reactive, and `None` until that session's first load settles (a failed load settles empty). Another session's catalog is never offered for it
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
