# Transcript

The split region is a canvas: the footer's base (composer, status row, the
activity row and the waiting entries while they carry content) and the live tail, the transcript's
last rows. OpenTUI draws only the region, and a region that grows at the
terminal's bottom pushes rows into scrollback that cannot come back, so
growing UI never grows it: the suggestions and the docked panes cover the
tail's last rows, and the footer's base stays as it was while one is open
(`paneOpen`, from `useDockPaneOpen` in `ui.tsx`). The tail shows the rows the
region holds over the footer's base as it is now: a base that grows (the
activity row as a turn starts) moves the tail's top rows into history, and
one that shrinks (the activity row going at a turn's end) leaves blank rows
above the tail until it grows into them, never above the composer; so does a
tail that shrinks after history took its top rows (a tool run that folds).
Blank rows inside an item (history holds its top rows) that stay for 300 ms
replay the transcript (`watchGap`). A replay clears the screen and the saved
lines and writes every row again, so its cost grows with the session: nothing
a turn does as it runs may shrink the tail or flap the base. Every turn that
ends gets its turn line, however short (`Worked for <1s`): it takes the rows
the activity row gives back. A thought waits
inside its open run (`projectToolRuns`), and a `Running` from the runtime
stream for a turn whose `TurnCompleted` has landed starts nothing (the
runtime stream and the event feed are two streams; `client.tsx`). Patched OpenTUI grows the region with line
feeds at the screen's last row, which keep the rows they push in scrollback
(its own `CSI S` drops them). The rows above the canvas go to native history in order, only from final items
(`isFinalItem` in `message-list.tsx`: a streamed `draft` answer waits for
its stored answer, a message waits while a call of it runs, and the head of
a tool run waits until the run ends): an item whole, or its top rows
(`partialRows`; the live view cuts them off), during a turn too, so each
final row is in history or on screen, once. Patched OpenTUI crops a box's
border to the scissor of the boxes around it, with the box's own geometry and
titles, so a cut prompt draws no rail above the tail. A commit shrinks the region by its rows
first and then writes them, so they land where they were drawn; a write
OpenTUI refuses, or rows drawn from an item that changed while they settled,
give the rows back to the live view; an item that changes
after history took its top rows replays the transcript. One pass's offers
draw and settle side by side (`SURFACES_AT_ONCE`), then land together in one synchronous step
(`writeOffers`), so one frame writes all their rows; a replay's reset
(`historyResetPending`) lands with them, and patched OpenTUI writes its clear
inside that frame (`patches/README.md`): the screen keeps its old frame until
the new one is whole, never blank. The tail scrolls no further than the top
row it drew (`drawn`) while final rows show from there (`topLimit`, a
`maxHeight` on the box the scrollbox scrolls, so it holds before layout): new
rows at the bottom wait a frame, or until history takes the rows above, and
no frame shows a final row in neither history nor the region. The tail's
height (`liveHeight`) is read from its layout every frame. A region above the
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
screen back first, as scrollback takes no rows from the alternate one). The
renderer is created with `clearOnShutdown: true`: in split mode OpenTUI's
close clears only the region, from its top row down, and leaves the cursor on
that row, so every turn stays on screen and the shell prompt follows it.

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
header is verb phrases in the words its preview rows use, one a kind, largest
first: `● Read 3 files · ran 2 commands · searched 1 pattern · edited 1 file ·
1 failed` (`activityHeaderRuns`). It counts a cell's ops (any other call is
the one op it is; a cell with no ops counts the calls its source spells out,
`ran code` when it names none, never its code). The ops still running read
last in the running tense (`… · running 1 command`), and the failures and
cancels end it. A header has no head count, no thoughts and no time: the turn
line holds the time. An MCP tool (`mcp.<server>.<tool>`) counts as its server
(`called linear 2×`) and its rows read `Called linear.list_issues …`; a tool
with no unit counts its calls (`lint_fix 2×`). A narrow header drops kinds
from the right and keeps the first kind, the failures and the cancels. The
glyph is `●` when done, a `○`/`●` blink while a call runs (the `◇◈◆` pulse
is a running child agent's alone), `✗` in the error colour when a call failed, and `●` in the
warning colour when only ops failed inside a cell that recovered. A bash op
whose command exits nonzero is a failed op, as fx counts it, though its call
succeeded (`callOperation`). Hue goes only where the reader must look, as
Codex colours its failures: the glyph, `N failed` in the error colour and
`N cancelled` in the warning colour; the header's work, the connectors and
the reasons stay muted (`activityHeaderRuns`, `ActivityTone`; `activityToneColor` in `ui.tsx` is the one map from tone to colour, for the tool group and for a child's row, whose work draws as a run header does). One blank row
parts a tool run from the answer text before it and after it, in one message
as across two (`gapBefore` in `AssistantMessage`).

The `ctrl+o` ladder (`DisclosureLevel` in `extensions/client-facets.ts`) keeps
three levels for every block, as opencode's web app folds tool calls to one
line and fx draws them as a tree. Collapsed (the default) is one head line a
block, plus one line a failure, so a failure shows at every level. Preview is
the tree: one line a child. Full opens the bodies. `esc` collapses.

- **Tool group.** Collapsed draws the header and, under it, one row for each
  failed call or op (`collapsedOperations`, `failureRowRuns`):
  `└ Ran ls d.ts · exit 2 · ls: cannot access …`, only its outcome word
  (`exit 2`, `failed`) in the error colour (`cancelled` in the warning
  colour), the rest muted; a preview row colours its outcome word the same
  way (`ActivityRowText.ending`). The row keeps the verb, the
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
  the op it cut reads `└ Ran sleep 20 · cancelled`, its `cancelled` in the warning colour, the
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
  ops folds into one frame (`read 30 files`), its body a tight list, one
  row an op in its tool row's shape: `✓ src/a.ts · 3 lines`, the path once
  (`summaryAfterSubject` drops a receipt's lead that repeats the subject and
  places its other paths). The outcome glyph and a code line's `N │ ` gutter
  are columns of their own, so a wrapped row hangs under its words. The
  transcript view (full detail) draws every op on its own
  (`FoldOperationsProvider`). An edit's collapsed body draws its hunks only
  (`diffHunkLines`: no `Index:`/`===`/`---`/`+++` preamble).
- **Reasoning.** A run takes the reasoning just before its first call (from
  that call's own message only: an earlier message may already be in
  history), the reasoning between its calls, and the reasoning just before the
  answer text that ends it; the header counts none, and full draws each where
  it came. While a turn runs, the open run takes the
  reasoning since its last call at once (as its closing reasoning until a call
  or answer text follows), so a thought never draws on its own and then
  leaves the live tail when the next call joins. Reasoning with no run is
  hidden at collapsed (as Claude Code hides thinking) and one line at
  preview, `∴ Thought · <first summary> · N summaries`. At full and in the
  transcript view every reasoning block, a run's too, opens under a `∴` at
  column 2 and hangs its text at column 4.
- **Thread round end** (`session-tools.client.tsx`). A `thread.start` with
  `notify: "starter"` settles at once (its row reads `thread <id> · result
  arrives as a message`; any other start, `· replies stay in the thread`),
  and each round's answer arrives later as a `thread-round-end` message.
  Collapsed is one line at column 2,
  `◆ <thread's name> · completed · Read 10 files · ran 4 commands · 1m 12s · ↑1.2k ↓300 $0.01`:
  the thread's session name, else its agent's name; the start row reads
  `Started <name> · <task>`; how the round ended; the work in the run
  header's words (from the details' `toolCounts`, so it counts every call),
  its time and its bill. A round that ended badly draws `✕` and says how
  (`· model stream failed`), then ends with its error. Narrow, the error is
  cut first; then the work's later kinds drop, then the bill, then the time,
  then the work; how it ended never drops, and the name is cut for it. The
  thread's id shows at full, or when the thread has no session name. Preview
  adds the round's last five calls as run rows (`├ … 9 earlier calls`,
  `└ Read a.ts, b.ts +1`) and a five-line head of its answer. Full draws a
  row per kept call and the whole answer, muted and hanging at column 4. The
  receipt line and the `thread.round(…)` pointer the model reads never draw.
  It draws no user rail and no `●`: a thread has its own glyph. The head is
  muted but the thread's name, in the info colour (Codex draws an agent's
  nickname in its accent), and a bad end's `✕` and failures, in the error
  colour; its call rows colour only their outcome words, as a run's rows do.
- **Connection notice** (`ConnectionWidget` in `app.tsx`). Collapsed is one
  line that counts the issues (`• connection · 6 model catalogs unavailable ·
  ctrl+o`), with a tree row for each failed extension; preview and full list
  every issue on its own row. It is in the live tail, so a level change costs
  no replay.
- **Session rows** (`SessionEventIndicator`). Each sits at column 2 under its
  own glyph and hangs a wrapped line at column 4: `✻` the turn line, `✗` an
  error, `■ Interrupted · what should gent do instead?` in the warning colour,
  `↻` a retry, a notice's own glyph. The turn line is `✻ Worked for 1m 48s ·
  2 retries · ↑38k ↓2.1k · $0.04` (`formatTurnLine`), muted, one blank row
  above; the retry slot is there only when a provider call was retried, and
  preview and full add `· N steps`. Narrow, its parts drop from the right and
  the time stays. A settled retry is hidden at collapsed and reads `↻ Retried
  1/3 · <reason>` from preview on, where it happened, inside the run it
  split nothing of. Below full, an error over four lines shows four, then
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
does. A retry row, pending or settled, ends nothing. The run draws at its
first tool-call segment (its head); the later steps skip the segments it took.
The reasoning it took draws where it came at the full level only; a closing
thought from a streamed answer keeps the head waiting for the stored answer. The
native transcript draws each item on its own, so it projects the runs once over
every displayed item and gives them to the live view and to each history
surface (`ToolRunsContext`). A message that heads a run is final only once the
run has ended, holds no streamed step and no running call; its fingerprint
holds the run's calls and the reasoning it took (`historyFingerprints`), so a run that grows after
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
it is, from the metadata alone: a custom type whose
`messageRendererContribution` passes `prompt`, in the text that function reads
(the `/btw` fork's question, or a `/btw` merge as `merged <fork name>`, which
the reader sent but whose text the model reads is ids), or else a user message
with the server's client origin (`fromClient`: typed, or a steer that joined
the running turn). A message another agent or an extension sent (a parent's
`Session.send`, a wake, a thread's round) and a hidden message are not. It is the first row a
short terminal gives up: it shows only while the live tail keeps a row beside
it. The expanded transcript and overlays pin nothing, and the terminal owns
scrollback, so there is no jump back to the original. The prompt is a memo of
the displayed items; a measurement only looks heights up by index and stops
summing once the answer is known, so per-frame work never grows with history.

## Renderer facts

OpenTUI's split footer draws only its own region buffer (`getSplitPinnedRenderOffset` and the `footerHeight` setter in `@opentui/core` 0.5.14 `renderer.ts`), which is why growing UI never grows the region. In a long session the region takes all its rows (`regionMax`, the terminal less two rows). A tool group is one run of calls across the steps of a turn (`projectToolRuns`; reasoning and blank text pass, answer text, a user message, a session row or an ask end it), drawn at the message that holds its first call; its fingerprint holds the run's calls and the reasoning it took, and it takes the reasoning before its first call only from that call's own message, as an earlier message may already be in history. The top rows of a final item commit through `ScrollbackSurface.commitRows` with a row range. A whole item whose highlight does not settle in three tries commits as plain text. A commit ends on its last row, with no trailing newline: OpenTUI counts the empty row a newline leaves as history, so on a short screen the region would start a row under the rows. Unpatched, a return from the alternate screen seeds the split from the cursor at column 0: the next commit overwrites the last history row, and a short session's screen goes to scrollback a second time (`patches/README.md`). Only the first transcript keeps the shell's lines above gent, as nothing of gent is above it. Exit and SIGINT, SIGTERM or SIGHUP leave the terminal the same way (`leaveTerminal`; the renderer has no listener of its own for those signals, `exitSignals`, which would destroy it before the flush), and a turn in flight commits as drawn and as plain text (`flushTranscriptForExit`, bounded at 1.5 s). An answer with a mermaid fence reaches history only once the diagram library's one load has ended, loaded or failed (`diagramsDrawable`). The session feed retains the data for disclosure and resize replay. User messages use an OpenTUI heavy left border, so snapshot layout does not depend on a later height callback; right of it a user message sits on the reader's surface (`theme.backgroundPanel`), and history holds until the terminal's palette read has ended (`paletteSettled`), so a user row reaches scrollback, and every replay, with its fill. Incremental one-shot output remains separate work.
