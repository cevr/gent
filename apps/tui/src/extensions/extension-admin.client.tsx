/** @jsxImportSource @opentui/solid */
import { Effect, Match, Option, Queue } from "effect"
import { createEffect, createSignal, on, Show } from "solid-js"
import { type ExtensionStatus, ref } from "@gent/core/extensions/api"
import { EXTENSION_ADMIN_EXTENSION_ID, ExtensionAdminRpc } from "@gent/extensions/client"
import {
  ChromePanel,
  clientCommandContribution,
  ClientContext,
  clientContributions,
  defineClientExtension,
  fitWidth,
  keyHint,
  KeyHints,
  PickerFrame,
  plainRow,
  SelectList,
  type SelectListRow,
  sessionQuery,
  textWidth,
  usePickerGeometry,
  useScopedKeyboard,
  useTheme,
  widgetContribution,
} from "@gent/tui/extensions"

// ── extensions pane ─────────────────────────────────────────────────────────

/**
 * `/extensions` — one docked pane over the session's extensions, as the next
 * turn resolves them (`extensions.pane.status`, which loads a file written
 * since the last turn). A row names the extension, its scope, its state and
 * the version it runs. `space` turns the extension off or on and `r` sets it
 * up again: each is the reader's own act, so it asks nothing, and the client
 * extensions load again after it (`shell.reloadExtensions`), so a client half
 * follows its server half. Changes run one at a time, in key order, each on
 * the status the one before it left. `enter` shows a failure's whole text.
 *
 * The pane is the client half of `@gent/extension-admin`; the agent reaches
 * the same changes through that extension's tools, which ask.
 *
 * @module
 */

/** The pane's name in the host's one pane slot. */
const EXTENSIONS_PANE = "extensions.pane"

const shortVersion = (version: string): string => version.slice(0, 12)

const firstLine = (text: string): string =>
  Option.getOrElse(
    Option.fromUndefinedOr(text.split("\n").find((line) => line.trim().length > 0)),
    () => "",
  ).trim()

/** The state a row names: `on`, `reload failed`, `failed`, `off`. */
const stateWord = (status: ExtensionStatus): string =>
  Match.valueTags(status, {
    Active: (active) =>
      Option.match(Option.fromUndefinedOr(active.reloadFailed), {
        onNone: () => "on",
        onSome: () => "reload failed",
      }),
    Failed: () => "failed",
    Disabled: () => "off",
  })

/** The version an extension runs: none for a builtin, a failed one, or one turned off. */
const runningVersion = (status: ExtensionStatus): Option.Option<string> => {
  if (status._tag !== "Active") return Option.none()
  return Option.map(Option.fromUndefinedOr(status.version), shortVersion)
}

/** An id keeps at least this many columns before the row drops its version, then its scope. */
const ID_COLUMNS = 16

/**
 * `@user/notes            user · on · 0123456789ab`: the id on the left, and
 * on the right the scope, the state and the version. A narrow row drops the
 * version first, then the scope; the state stays.
 */
export const extensionRow = (status: ExtensionStatus, width: number): string => {
  const state = stateWord(status)
  const variants = [
    [status.scope, state, ...Option.toArray(runningVersion(status))],
    [status.scope, state],
    [state],
  ].map((parts) => parts.join(" · "))
  const idColumns = Math.min(textWidth(status.id), ID_COLUMNS)
  const right = Option.getOrElse(
    Option.fromUndefinedOr(variants.find((variant) => width - textWidth(variant) - 2 >= idColumns)),
    () => state,
  )
  return `${fitWidth(status.id, Math.max(0, width - textWidth(right) - 2))}  ${right}`
}

/** The line under the list about the row under the cursor. */
export const extensionDetail = (status: ExtensionStatus): string =>
  Match.valueTags(status, {
    Active: (active) =>
      Option.match(Option.fromUndefinedOr(active.reloadFailed), {
        onNone: () => active.sourcePath,
        onSome: (failed) => `new version failed at ${failed.phase}: ${firstLine(failed.error)}`,
      }),
    Failed: (failed) => `failed at ${failed.phase}: ${firstLine(failed.error)}`,
    Disabled: () => "turned off in a config · space turns it on",
  })

/** A failure's whole text, which `enter` shows; none for an extension that did not fail. */
export const extensionIssue = (status: ExtensionStatus): Option.Option<string> =>
  Match.valueTags(status, {
    Active: (active) =>
      Option.map(
        Option.fromUndefinedOr(active.reloadFailed),
        (failed) =>
          `The new version failed at ${failed.phase}; version ${Option.getOrElse(runningVersion(status), () => "builtin")} still runs.\n\n${failed.error}`,
      ),
    Failed: (failed) => Option.some(`Failed at ${failed.phase}.\n\n${failed.error}`),
    Disabled: () => Option.none(),
  })

/** `Extensions · 12 on · 1 failed · 2 off`; a count of none is left out, `on` stays. */
export const paneTitle = (extensions: ReadonlyArray<ExtensionStatus>): string => {
  const count = (word: string) => extensions.filter((status) => stateWord(status) === word).length
  const parts = [`${count("on")} on`]
  for (const word of ["reload failed", "failed", "off"]) {
    if (count(word) > 0) parts.push(`${count(word)} ${word}`)
  }
  return ["Extensions", ...parts].join(" · ")
}

/** Whether a row needs the reader: the pane opens on the first such row. */
const needsReader = (status: ExtensionStatus): boolean => stateWord(status) !== "on"

/** A row's key: an id is unique within a scope. */
const statusKey = (status: ExtensionStatus): string => `${status.scope}:${status.id}`

/** The rows a body of text takes at `width`, each paragraph wrapped. */
const wrappedRows = (text: string, width: number): number =>
  text
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(textWidth(line) / Math.max(1, width))), 0)

/** The most rows the issue text takes before it scrolls out of the frame. */
const ISSUE_ROWS = 12

/** A frame's rows around its body: two rules, the title and the key hints. */
const FRAME_CHROME_ROWS = 4

interface ExtensionsController {
  readonly extensions: () => ReadonlyArray<ExtensionStatus>
  readonly loading: () => boolean
  /** A failed read or a refused change, newest first. */
  readonly error: () => Option.Option<string>
  /**
   * What the last changes did, each on the row it changed, until the pane
   * closes: the replies of changes pressed while one ran stay together.
   */
  readonly notes: () => ReadonlyArray<ChangeNote>
  readonly clearNote: () => void
  readonly refresh: () => void
  readonly toggle: (status: ExtensionStatus) => void
  readonly reload: (status: ExtensionStatus) => void
  readonly open: () => boolean
  readonly close: () => void
}

/** A change's reply and the row it reports on (`statusKey`). */
interface ChangeNote {
  readonly key: string
  readonly text: string
}

/** A change the reader pressed: the row, and the request it makes on the row's current status. */
interface PendingChange {
  readonly status: ExtensionStatus
  readonly act: (
    current: ExtensionStatus,
  ) => Effect.Effect<{ readonly detail: string }, { readonly message: string }>
}

const noStatuses: ReadonlyArray<ExtensionStatus> = []

const makeExtensionsController = Effect.gen(function* () {
  const { transport, shell, lifecycle } = yield* ClientContext
  const statuses = yield* sessionQuery({
    initial: noStatuses,
    follow: false,
    fetch: (session) =>
      transport
        .request(ref(ExtensionAdminRpc.Status), {}, session)
        .pipe(Effect.map((output) => output.extensions)),
  })
  const [notes, setNotes] = createSignal<ReadonlyArray<ChangeNote>>([])
  const [changeError, setChangeError] = createSignal(Option.none<string>())
  /** The row's status as the server holds it now, or as the pane last read it. */
  const currentStatus = (status: ExtensionStatus) =>
    transport
      .request(ref(ExtensionAdminRpc.Status), {})
      .pipe(
        Effect.map((output) =>
          Option.getOrElse(
            Option.fromUndefinedOr(
              output.extensions.find((current) => statusKey(current) === statusKey(status)),
            ),
            () => status,
          ),
        ),
      )

  /**
   * Run one change on the row's status as the changes before it left it.
   * Its reply joins the row's notes; the first change of a run starts them
   * again. The pane and the client extensions read again after each.
   */
  const runChange = (pending: PendingChange, first: boolean) =>
    currentStatus(pending.status).pipe(
      Effect.flatMap(pending.act),
      Effect.match({
        onFailure: (failure) => {
          if (first) setNotes([])
          setChangeError(Option.some(failure.message))
        },
        onSuccess: (output) => {
          if (first) setChangeError(Option.none())
          const note = { key: statusKey(pending.status), text: output.detail }
          setNotes((current) => [...current.filter(() => !first), note])
          statuses.refresh()
          shell.reloadExtensions()
        },
      }),
    )

  // One change at a time, in the order the keys came: each acts on the
  // status the change before it left, so `space` then `r` on an extension
  // that is off turns it on and then sets it up. The changes pressed while
  // one runs make one run, and every reply of the run shows, a refusal
  // included.
  const mailbox = yield* Queue.unbounded<PendingChange>()
  const runChanges = Effect.gen(function* () {
    let next = Option.some(yield* Queue.take(mailbox))
    let first = true
    while (Option.isSome(next)) {
      yield* runChange(next.value, first)
      first = false
      next = yield* Queue.poll(mailbox)
    }
  }).pipe(Effect.forever)
  yield* lifecycle.scoped(Effect.forkScoped(runChanges))

  const change = (status: ExtensionStatus, act: PendingChange["act"]) => {
    Queue.offerUnsafe(mailbox, { status, act })
  }

  return {
    extensions: statuses.value,
    loading: statuses.loading,
    error: () => Option.orElse(changeError(), statuses.error),
    notes,
    clearNote: () => setNotes([]),
    refresh: () => {
      setNotes([])
      setChangeError(Option.none())
      statuses.refresh()
    },
    toggle: (status) =>
      change(status, (current) =>
        transport.request(ref(ExtensionAdminRpc.SetEnabled), {
          id: current.id,
          enabled: current._tag === "Disabled",
        }),
      ),
    reload: (status) =>
      change(status, (current) =>
        transport.request(ref(ExtensionAdminRpc.Reload), { id: current.id }),
      ),
    open: () => shell.pane.isOpen(EXTENSIONS_PANE),
    close: () => shell.pane.close(EXTENSIONS_PANE),
  } satisfies ExtensionsController
})

/** A failure's whole text, in place of the list; esc or enter goes back to it. */
function IssueView(props: {
  readonly status: ExtensionStatus
  readonly text: string
  readonly onBack: () => void
}) {
  const { theme } = useTheme()
  const { rowWidth } = usePickerGeometry()
  useScopedKeyboard((event) => {
    if (event.name !== "escape" && event.name !== "return") return false
    props.onBack()
    return true
  })
  return (
    <PickerFrame
      title={`${props.status.id} · ${stateWord(props.status)}`}
      keys={[KeyHints.back]}
      height={Math.min(ISSUE_ROWS, wrappedRows(props.text, rowWidth())) + FRAME_CHROME_ROWS}
      error={Option.none()}
    >
      <ChromePanel.Body>
        <text style={{ fg: theme.text }} wrapMode="word">
          {props.text}
        </text>
      </ChromePanel.Body>
    </PickerFrame>
  )
}

function ExtensionsPane(props: { readonly controller: ExtensionsController }) {
  const { rowWidth } = usePickerGeometry()
  const [cursor, setCursor] = createSignal(Option.none<ExtensionStatus>())
  const [issue, setIssue] = createSignal(
    Option.none<{ readonly status: ExtensionStatus; readonly text: string }>(),
  )
  const controller = props.controller
  // A pane that closes over a failure's text opens on the list again.
  // The row the reader last changed: the rows read again after a change can
  // come back in a new order, and the cursor stays on that row until the
  // pane closes.
  const [changed, setChanged] = createSignal(Option.none<string>())
  createEffect(
    on(controller.open, (open) => {
      if (open) return
      setIssue(Option.none())
      setChanged(Option.none())
      controller.clearNote()
    }),
  )
  const rows = (): ReadonlyArray<SelectListRow<ExtensionStatus>> =>
    controller.extensions().map((status) =>
      plainRow(status, () => extensionRow(status, rowWidth()), {
        muted: () => status._tag === "Disabled",
      }),
    )
  // A change's notes show on its row; the rows read again after the change
  // can pass the cursor over another row first.
  const detail = () =>
    Option.flatMap(cursor(), (status) =>
      Option.orElse(
        Option.liftPredicate(
          controller
            .notes()
            .filter((note) => note.key === statusKey(status))
            .map((note) => note.text)
            .join(" · "),
          (text) => text.length > 0,
        ),
        () => Option.some(extensionDetail(status)),
      ),
    )
  const showIssue = (status: ExtensionStatus) =>
    Option.match(extensionIssue(status), {
      onNone: () => {},
      onSome: (text) => setIssue(Option.some({ status, text })),
    })
  return (
    <Show when={controller.open()}>
      <Show
        when={Option.getOrUndefined(issue())}
        fallback={
          <PickerFrame
            title={paneTitle(controller.extensions())}
            keys={[
              KeyHints.move,
              keyHint("space", "on/off"),
              keyHint("r", "reload"),
              keyHint("enter", "issue"),
              KeyHints.close,
            ]}
            detail={detail()}
            error={controller.error()}
          >
            <SelectList
              id="extensions"
              open={controller.open()}
              rows={rows}
              rowKey={statusKey}
              sticky={(values) =>
                Option.orElse(
                  Option.flatMap(changed(), (key) =>
                    Option.liftPredicate(
                      values.findIndex((status) => statusKey(status) === key),
                      (index) => index >= 0,
                    ),
                  ),
                  () => Option.some(Math.max(0, values.findIndex(needsReader))),
                )
              }
              onCursor={setCursor}
              loading={controller.loading}
              onSelect={showIssue}
              onDismiss={controller.close}
              extraKeys={(event, selected) => {
                if (event.name === "space") {
                  Option.map(selected, (status) => {
                    setChanged(Option.some(statusKey(status)))
                    controller.toggle(status)
                  })
                  return true
                }
                if (event.name === "r" && event.ctrl !== true && event.meta !== true) {
                  Option.map(selected, (status) => {
                    setChanged(Option.some(statusKey(status)))
                    controller.reload(status)
                  })
                  return true
                }
                return false
              }}
            />
          </PickerFrame>
        }
      >
        {(shown) => (
          <IssueView
            status={shown().status}
            text={shown().text}
            onBack={() => setIssue(Option.none())}
          />
        )}
      </Show>
    </Show>
  )
}

export default defineClientExtension(EXTENSION_ADMIN_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { shell } = yield* ClientContext
    const controller = yield* makeExtensionsController
    return clientContributions(
      clientCommandContribution({
        id: "extensions.pane",
        title: "Extensions",
        description: "Show the session's extensions; turn one off or on, or set it up again",
        category: "Session",
        slash: "extensions",
        onSelect: () => {
          shell.pane.open(EXTENSIONS_PANE)
          controller.refresh()
        },
      }),
      widgetContribution({
        id: EXTENSIONS_PANE,
        slot: "below-input",
        component: () => <ExtensionsPane controller={controller} />,
      }),
    )
  }),
})
