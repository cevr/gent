# Layout: providers, views and the footer

Startup blocks before render — `main.tsx` calls `waitForReady` + `resolveInteractiveBootstrap` before `render()`. No loading route.

Providers wrap app in `main.tsx`:

```
EnvProvider → WorkspaceProvider → ClientProvider → ExtensionUIProvider → TerminalDimensionsProvider → SpinnerClockProvider → ComposerMemoryProvider → App
```

| Provider                     | Purpose                                             |
| ---------------------------- | --------------------------------------------------- |
| `EnvProvider`                | `$VISUAL`/`$EDITOR`, graceful `shutdown`            |
| `WorkspaceProvider`          | launch cwd and home - static workspace info         |
| `ClientProvider`             | transport client, session state, event stream       |
| `ExtensionUIProvider`        | extension loading, command list, composer dispatch  |
| `TerminalDimensionsProvider` | terminal width and height, one reactive reader      |
| `SpinnerClockProvider`       | the one 60 ms clock spinners and blinks read        |
| `ComposerMemoryProvider`     | drafts, refusals, prompt history, startup prompt    |
| `SessionControllerContext`   | session-scoped: auth gate, overlays, composer state |

Session-view owners (the general state ownership rules are in `apps/tui/AGENTS.md`):

- Auth is a view (`auth.tsx`); when the session controller's auth gate detects missing required providers it docks in the footer like every pane, one `PickerFrame` per screen (provider list, a provider's credentials, the label line, methods, the key line, an OAuth method's inputs, the OAuth wait). The credentials screen writes through the server only (`auth.setOrder`, `auth.renameKey`, `auth.deleteKey`) and reads the catalog again; it keeps no copy of the order.
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
(`keyHint` and `KeyHints` in `ui.tsx`, also exported to client extensions):
lowercase keys, one `·` separator, Enter `select` on a row and `submit` on
typed text, Esc `close` on a pane and `back` on a sub-screen. A narrow row
drops the move hint first, then takes each hint's short verb from the right
(`keyHint(key, verb, short)`: `/revert` reads `enter all` for `enter files +
conversation`), then drops hints from the right, and keeps the way out
(`fitKeyHints`). `KeyHintsText` draws what is kept as Codex does: each key
bright (`theme.text`), its verb and the separators muted (`theme.textMuted`),
both from `keyHintColors`, the one owner of those colors. It draws them as tone
runs (`TextRun` and `ToneRuns`), as every line drawn in parts does. Every hint row draws
through it: a pane's, an ask's footer, the live line's `esc cancel`, the queue's
`alt+up edit`, the empty state's `ctrl+p commands`, the wake tray's resume row, the agents tray's `← sessions`; an extension reaches it, `keyHintsWidth` and the `KeyHints` words through `@gent/tui/extensions`. A status-row label that is
a hint (`esc close` beside `transcript`) names its key (`StatusRowLabel.key`)
and `StatusRow` draws that key bright too.

The live line (`ActivityRow` in `app.tsx`) reads
`✻ <phase> (<elapsed>) · esc cancel`; the `✻` pulses on the spinner clock.
The phase is `Thinking` until answer text streams, then `Generating`. Once a
step of the running turn stored reasoning with a heading, the phase names the
newest one, as Codex's status header does: a summary whose first line is bold
(`**Investigating the bug**`, with any text after the bold) or a markdown
heading (`latestReasoningHeading` in `utils.ts`). Reasoning prose never reaches
the line. The client sees reasoning only in a step's stored message, so the
heading names the last step that ended and stays through its tool calls; a
retry's countdown takes the line while it waits. The phase is the
running call's words while one runs (a `cell` reads in its source's verbs,
`Reading 3 files`, never its code: `runningCallLabel` in `utils.ts`); and
`Waiting for your answer` while the turn waits on an ask. The count runs from
the runtime's `startedAtMs` (`SessionControllerState.turn` in `session.tsx`),
the start the turn's `Worked for` total counts from: a new step, a tool call or
an ask changes the word, not the count, and the next turn counts from its own
start. A `!cmd` outside a turn counts from its own start.

Under it sit the reader's waiting entries (`QueueWidget` in `app.tsx`, drawn
from the controller's `queue`, their one owner), in the reader's lane: one dim
row each, `┊ next step · <first line>` for a steer and `┊ next turn · <first
line>` for a follow-up (or the type's `queueLabel`), cut to the width and ending
` +N lines` for more lines; at most three, then `┊ +N more`; then
`alt+up edit`, which takes them back into the draft. Only the reader's own
messages draw (`metadata.fromClient`, the server's client origin): one another
agent or an extension queued (a child's `Session.send`, a wake) draws nowhere
while it waits, and `alt+up` (the `queue.drain` RPC) leaves it queued to be
delivered. None is a transcript row: an entry leaves when it is delivered,
and the transcript shows it where it lands.

The footer (composer, trays, docked panes) never outgrows the split-footer
region (`DockFooter`'s `maxHeight` in `app.tsx`). While a docked pane is open
the trays and the waiting entries hide (`TrayFrame` and `QueueWidget` read the
`DockProvider` count each `PickerFrame` adds to), so the pane the reader
opened gets the rows. The footer's blank
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

## Key Files (Composer + Session)

| File               | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `src/session.tsx`  | session-screen orchestration                     |
| `src/app.tsx`      | boot flow, session view, queue widget            |
| `src/composer.tsx` | composer render + wiring, popup, shell execution |
| `src/utils.ts`     | @file#line expansion                             |
| `src/commands.tsx` | Slash command handlers                           |
