/** @jsxImportSource @opentui/solid */
import { Clock, DateTime, Effect, Option, Random } from "effect"
import { createEffect, createSignal, on, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import {
  CHECKPOINTS_EXTENSION_ID,
  type CheckpointListType,
  CheckpointsRpc,
  RevertAction,
  type RevertOutcomeType,
} from "@gent/extensions/client"
import {
  type ActiveExtensionSession,
  clientCommandContribution,
  ClientContext,
  clientContributions,
  decoration,
  defineClientExtension,
  formatAge,
  keyHint,
  KeyHints,
  PickerFrame,
  plainRow,
  plural,
  SelectList,
  type SelectListRow,
  sessionQuery,
  textWidth,
  truncate,
  usePickerGeometry,
  useTheme,
  widgetContribution,
} from "@gent/tui/extensions"

/**
 * `/revert` — one docked pane over the turns of the branch in view, newest
 * first, from `checkpoints.list`: `#n · prompt · +a -d in k files · 12m`.
 * `enter` takes the files and the conversation back to before the turn (the
 * conversation on a new branch, which the shell moves to); `f` takes the
 * files only. A refusal names its reason and the paths others also changed;
 * `o` then writes them all the same, and undo returns them. While the newest
 * action was a revert, the top row undoes it; a revert a stop cut short
 * offers to finish it or to undo it. A turn with no checkpoint shows why and
 * cannot be chosen. The pane refuses while the session in view runs a turn.
 *
 * The pane is the client half of `@gent/checkpoints`; `/diff turn n` reviews
 * a row's change, and `/fork` takes the conversation back alone.
 *
 * @module
 */

/** The pane's name in the host's one pane slot. */
const REVERT_PANE = "checkpoints.revert"

type CheckpointList = CheckpointListType
type TurnRow = CheckpointList["turns"][number]

/** One choosable row: what `enter` does on it, what `f` does, and its line. */
interface RevertEntry {
  readonly key: string
  readonly enter: RevertAction
  /** The files-only revert; none on an undo or finish row. */
  readonly filesOnly: Option.Option<RevertAction>
  /** The turn the row reverts, for the detail line. */
  readonly n: Option.Option<number>
  /** What the reply's note says the revert did. */
  readonly done: (files: number) => string
  readonly line: (width: number, now: number) => string
}

/** `+12 -3 in 2 files`, or why the turn has nothing to revert to. */
const turnStats = (turn: TurnRow): string => {
  if (turn.state === "none") return "no checkpoint: no tool wrote in it"
  if (turn.state === "open") return "no end yet"
  return `+${turn.insertions} -${turn.deletions} in ${plural(turn.files, "file")}`
}

/**
 * `#2 · fix the parser · +12 -3 in 2 files · 12m`. A narrow row drops the
 * age, then cuts the prompt; the number and the stats stay.
 */
export const turnLine = (turn: TurnRow, width: number, now: number): string => {
  const lead = `#${turn.n} · `
  const stats = turnStats(turn)
  const age = formatAge(now - turn.createdAt)
  const promptRoom = (tail: string) => width - textWidth(lead) - textWidth(tail) - 3
  let tail = `${stats} · ${age}`
  if (promptRoom(tail) < Math.min(12, textWidth(turn.prompt))) tail = stats
  const prompt = truncate(turn.prompt, Math.max(1, promptRoom(tail)))
  return truncate(`${lead}${prompt} · ${tail}`, width)
}

/** The rows over the turns: undo the newest revert, or finish or undo one a stop cut short. */
export const actionEntries = (list: CheckpointList): ReadonlyArray<RevertEntry> => {
  const undo = Option.match(Option.fromUndefinedOr(list.undo), {
    onNone: (): ReadonlyArray<RevertEntry> => [],
    onSome: (last) => [
      {
        key: `undo:${last.requestId}`,
        enter: RevertAction.cases.Undo.make({}),
        filesOnly: Option.none(),
        n: Option.none(),
        done: (files) => `undid the last revert: ${plural(files, "file")} written back`,
        line: (width) =>
          truncate(`↶ undo the last revert · ${plural(last.files, "file")} written back`, width),
      },
    ],
  })
  const unfinished = Option.match(Option.fromUndefinedOr(list.unfinished), {
    onNone: (): ReadonlyArray<RevertEntry> => [],
    onSome: (cut) => [
      {
        key: `finish:${cut.requestId}`,
        enter: RevertAction.cases.Finish.make({}),
        filesOnly: Option.none(),
        n: Option.none(),
        done: (files) => `finished the revert: ${plural(files, "file")}`,
        line: (width) => truncate("↻ finish the revert a stop cut short", width),
      },
      {
        key: `undo:${cut.requestId}`,
        enter: RevertAction.cases.Undo.make({}),
        filesOnly: Option.none(),
        n: Option.none(),
        done: (files) => `undid the cut-short revert: ${plural(files, "file")}`,
        line: (width) => truncate("↶ undo the revert a stop cut short", width),
      },
    ],
  })
  return [...undo, ...unfinished]
}

/** A turn's row; none for a turn with no checkpoint, which cannot be chosen. */
export const turnEntry = (turn: TurnRow): Option.Option<RevertEntry> => {
  if (turn.state === "none") return Option.none()
  return Option.some({
    key: `turn:${turn.messageId}`,
    enter: RevertAction.cases.Turn.make({ n: turn.n, conversation: true }),
    filesOnly: Option.some(RevertAction.cases.Turn.make({ n: turn.n, conversation: false })),
    n: Option.some(turn.n),
    done: (files) =>
      `reverted ${plural(files, "file")} to before turn #${turn.n} · /revert to undo`,
    line: (width, now) => turnLine(turn, width, now),
  })
}

/** `Revert · 4 turns`. */
const paneTitle = (list: CheckpointList): string =>
  ["Revert", plural(list.turns.length, "turn")].join(" · ")

/** A refusal's line: its reason, then the paths others also changed. */
export const refusalText = (reason: string, conflicts: ReadonlyArray<string>): string => {
  if (conflicts.length === 0) return reason
  return `${reason} · ${conflicts.join(", ")}`
}

const emptyList: CheckpointList = { turns: [] }

/** One revert asked: the row, its id and its action; a refusal over paths keeps it for `o`. */
interface Asked {
  readonly entry: RevertEntry
  readonly requestId: string
  readonly action: RevertAction
}

const makeRevertController = Effect.gen(function* () {
  const { transport, shell, activity } = yield* ClientContext
  const list = yield* sessionQuery({
    initial: emptyList,
    follow: true,
    fetch: (session) => transport.request(ref(CheckpointsRpc.List), {}, session),
  })
  const [error, setError] = createSignal(Option.none<string>())
  const [refused, setRefused] = createSignal(Option.none<Asked>())
  const [running, setRunning] = createSignal(false)

  /** The session's name, which the shell shows over the branch it moves to. */
  const sessionName = (sessionId: ActiveExtensionSession["sessionId"]) =>
    transport.threadSessions(sessionId).pipe(
      Effect.map((sessions) =>
        Option.getOrElse(
          Option.flatMap(
            Option.fromUndefinedOr(sessions.find((session) => session.id === sessionId)),
            (session) => Option.fromUndefinedOr(session.name),
          ),
          () => "Unnamed",
        ),
      ),
      Effect.orElseSucceed(() => "Unnamed"),
    )

  const landed = (asked: Asked, outcome: RevertOutcomeType, session: ActiveExtensionSession) =>
    Effect.gen(function* () {
      const entry = asked.entry
      if (outcome._tag === "Refused") {
        setError(Option.some(refusalText(outcome.reason, outcome.conflicts)))
        // Only paths in the way can be overwritten; a running loop cannot.
        setRefused(Option.liftPredicate(asked, () => outcome.conflicts.length > 0))
        return
      }
      setRefused(Option.none())
      setError(Option.none())
      shell.pane.close(REVERT_PANE)
      // A path that changed while the revert ran was written too; undo returns it.
      const kept = (outcome.kept ?? []).map(
        (file) => ` · ${file} changed during the revert; kept for undo`,
      )
      shell.notify(`${entry.done(outcome.files.length)}${kept.join("")}`)
      // A conversation revert made a branch: the shell moves to it.
      const made = Option.fromUndefinedOr(outcome.branchId)
      if (Option.isNone(made)) return
      const name = yield* sessionName(session.sessionId)
      shell.switchSession({ sessionId: session.sessionId, branchId: made.value, name })
    })

  const run = (entry: RevertEntry, action: RevertAction, requestId: string, overwrite: boolean) => {
    // A turn of this branch holds the side-mutation permit: the revert would
    // wait for its end with no word, so the pane says why at once.
    if (activity.snapshot().state === "working") {
      setError(Option.some("stop the turn first (Esc)"))
      return
    }
    if (running()) return
    setRunning(true)
    const session = transport.currentSession()
    shell.cast(
      transport.request(ref(CheckpointsRpc.Revert), { requestId, action, overwrite }, session).pipe(
        Effect.flatMap((outcome) => landed({ entry, requestId, action }, outcome, session)),
        Effect.catch((failure) => Effect.sync(() => setError(Option.some(failure.message)))),
        Effect.ensuring(
          Effect.sync(() => {
            setRunning(false)
            list.refresh()
          }),
        ),
      ),
    )
  }

  /** A fresh id per press: a repeat of the one request does its revert once. */
  const fresh = (entry: RevertEntry, action: RevertAction) =>
    shell.cast(
      Effect.gen(function* () {
        const stamp = yield* Clock.currentTimeMillis
        const salt = yield* Random.nextInt
        return `revert-${stamp.toString(36)}-${Math.abs(salt).toString(36)}`
      }).pipe(Effect.map((requestId) => run(entry, action, requestId, false))),
    )

  return {
    list: list.value,
    loading: list.loading,
    error: () => Option.orElse(error(), list.error),
    canOverwrite: () => Option.isSome(refused()),
    revert: (entry: RevertEntry) => fresh(entry, entry.enter),
    revertFiles: (entry: RevertEntry) =>
      Option.map(entry.filesOnly, (action) => fresh(entry, action)),
    // The refused request again, its paths written: it recorded nothing, so
    // its id is still free.
    overwrite: () =>
      Option.map(refused(), (last) => run(last.entry, last.action, last.requestId, true)),
    open: () => shell.pane.isOpen(REVERT_PANE),
    close: () => shell.pane.close(REVERT_PANE),
    reset: () => {
      setError(Option.none())
      setRefused(Option.none())
      list.refresh()
    },
  }
})

type RevertController = Effect.Success<typeof makeRevertController>

function RevertPane(props: { readonly controller: RevertController }) {
  const { theme } = useTheme()
  const { rowWidth } = usePickerGeometry()
  const controller = props.controller
  const [cursor, setCursor] = createSignal(Option.none<RevertEntry>())
  createEffect(
    on(controller.open, (open) => {
      if (open) controller.reset()
    }),
  )
  const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe())
  const choosable = (entry: RevertEntry) => plainRow(entry, () => entry.line(rowWidth(), now()))
  const rows = (): ReadonlyArray<SelectListRow<RevertEntry>> => {
    const list = controller.list()
    return [
      ...actionEntries(list).map(choosable),
      ...list.turns.map((turn) =>
        Option.match(turnEntry(turn), {
          onSome: choosable,
          onNone: () =>
            decoration<RevertEntry>(() => (
              <box paddingLeft={1}>
                <text style={{ fg: theme.textMuted }} wrapMode="none">
                  {turnLine(turn, rowWidth() - 1, now())}
                </text>
              </box>
            )),
        }),
      ),
    ]
  }
  const detail = () =>
    Option.map(cursor(), (entry) =>
      Option.match(entry.n, {
        onNone: () =>
          "writes back the files the revert wrote; a file changed since it is a conflict",
        onSome: (n) => `review: /diff turn ${n} · conversation only: /fork`,
      }),
    )
  const keys = () => [
    KeyHints.move,
    keyHint("enter", "files + conversation"),
    keyHint("f", "files only"),
    ...Option.toArray(
      Option.liftPredicate(keyHint("o", "overwrite"), () => controller.canOverwrite()),
    ),
    KeyHints.close,
  ]
  return (
    <Show when={controller.open()}>
      <PickerFrame
        title={paneTitle(controller.list())}
        keys={keys()}
        detail={detail()}
        error={Option.orElse(controller.error(), () =>
          Option.fromUndefinedOr(controller.list().problem),
        )}
      >
        <SelectList
          id="revert"
          open={controller.open()}
          rows={rows}
          rowKey={(entry) => entry.key}
          loading={controller.loading}
          onCursor={setCursor}
          onSelect={controller.revert}
          onDismiss={controller.close}
          extraKeys={(event, selected) => {
            if (event.ctrl === true || event.meta === true) return false
            if (event.name === "f") {
              Option.map(selected, controller.revertFiles)
              return true
            }
            if (event.name === "o") {
              controller.overwrite()
              return true
            }
            return false
          }}
        />
      </PickerFrame>
    </Show>
  )
}

export default defineClientExtension(CHECKPOINTS_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { shell } = yield* ClientContext
    const controller = yield* makeRevertController
    return clientContributions(
      clientCommandContribution({
        id: "checkpoints.revert",
        title: "Revert a turn",
        description:
          "Take the files, and the conversation, back to before a turn; or undo a revert",
        category: "Session",
        slash: "revert",
        onSelect: () => shell.pane.open(REVERT_PANE),
      }),
      widgetContribution({
        id: REVERT_PANE,
        slot: "below-input",
        component: () => <RevertPane controller={controller} />,
      }),
    )
  }),
})
