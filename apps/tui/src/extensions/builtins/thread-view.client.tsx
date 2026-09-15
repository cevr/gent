/** @jsxImportSource @opentui/solid */
/**
 * Thread view — one docked pane over the chain of sessions and the context
 * windows inside each.
 *
 * A thread is a view, not a record. `Session.parentSessionId` links a session
 * to the one it continued from, and every `context-window` marker on a branch
 * opens a new window whose notice summarizes what left the model view. The
 * pane walks the chain up from the shell's session and lists the windows per
 * session, oldest first, so a reader sees the whole thread while the model
 * sees one window.
 *
 * Client-first: `session.list` and `message.list` are the only reads.
 *
 * @module
 */

import { DateTime, Effect, Option, Schema } from "effect"
import { createSignal, Show } from "solid-js"
import type { BranchId, Message, Session, SessionId } from "@gent/core/protocol"
import { ChromePanel } from "../../components/chrome-panel"
import { formatAge, plural } from "../../components/message-list-utils"
import {
  SelectList,
  decoration,
  selectable,
  type SelectListRow,
} from "../../components/select-list"
import { useTheme } from "../../theme"
import { truncate } from "../../utils/truncate"
import {
  clientCommandContribution,
  clientContributions,
  defineClientExtension,
  widgetContribution,
  type OverlayProps,
} from "../client-facets"
import { ClientLifecycle, ClientShell, makeClientSessionQuery } from "../client-services"
import { ClientTransport } from "../client-transport"

export const THREAD_VIEW_EXTENSION_ID = "@gent/thread-view"

const CONTEXT_WINDOW_MESSAGE_TYPE = "context-window"

/** The marker details the pane reads; the loop owns the full schema. */
const WindowDetails = Schema.Struct({
  keepFromMessageId: Schema.String,
  summarized: Schema.optional(Schema.Struct({ count: Schema.Natural })),
})
type WindowDetails = typeof WindowDetails.Type
const decodeWindowDetails = Schema.decodeUnknownOption(WindowDetails)

const windowDetailsOf = (message: Message): Option.Option<WindowDetails> => {
  if (message.metadata?.customType !== CONTEXT_WINDOW_MESSAGE_TYPE) return Option.none()
  return decodeWindowDetails(message.metadata.details)
}

/** One context window on one branch: what the model saw between two handoffs. */
export interface ThreadWindow {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sessionName: string
  /** 1-based position within its session. */
  readonly index: number
  readonly firstMessageId: string
  readonly lastMessageId: string
  readonly count: number
  /** The summary that opened the window; none for a session's first window. */
  readonly summary: Option.Option<string>
  /** Messages the opening handoff replaced. */
  readonly summarizedCount: number
  /** Messages the last projection left out of the model's view; only the live window has any. */
  readonly omittedCount: number
  /** First line of the first user message in the window. */
  readonly preview: string
  readonly updatedAt: number
}

const messageText = (message: Message): string =>
  message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      return []
    })
    .join("\n")

/** The first line that says something: blank lines and markdown headings are skipped. */
const firstLine = (text: string): string => {
  const line = text
    .split("\n")
    .find((candidate) => candidate.trim().length > 0 && !candidate.trim().startsWith("#"))
  return Option.getOrElse(Option.fromUndefinedOr(line), () => "").trim()
}

/** The notice carries a preamble the reader does not need; keep the summary after it. */
export const summaryBody = (notice: string): string => {
  const at = notice.indexOf("\n\nSummary:\n")
  if (at < 0) return notice
  return notice.slice(at + "\n\nSummary:\n".length)
}

export const sessionLabel = (session: Session): string =>
  Option.fromUndefinedOr(session.name).pipe(
    Option.orElse(() => Option.fromUndefinedOr(session.cwd)),
    Option.getOrElse(() => session.id),
  )

/**
 * The sessions a thread runs through, root first. Each session names the one
 * it continued from, so the chain is the parent walk from the shell's
 * session; a session that is not listed ends it.
 */
export const threadChain = (
  sessions: ReadonlyArray<Session>,
  sessionId: SessionId,
): ReadonlyArray<Session> => {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const chain: Array<Session> = []
  const seen = new Set<string>()
  let cursor = Option.fromNullishOr(byId.get(sessionId))
  while (Option.isSome(cursor) && !seen.has(cursor.value.id)) {
    seen.add(cursor.value.id)
    chain.unshift(cursor.value)
    cursor = Option.fromUndefinedOr(cursor.value.parentSessionId).pipe(
      Option.flatMap((id) => Option.fromNullishOr(byId.get(id))),
    )
  }
  return chain
}

interface Cut {
  readonly at: number
  readonly marker: Message
  readonly details: WindowDetails
}

/** Where each marker cuts the branch: the index of its anchor among the non-marker messages. */
const cutsOf = (
  body: ReadonlyArray<Message>,
  markers: ReadonlyArray<Message>,
): ReadonlyArray<Cut> =>
  markers
    .flatMap((marker) =>
      Option.match(windowDetailsOf(marker), {
        onNone: () => [],
        onSome: (details) => {
          const at = body.findIndex((message) => message.id === details.keepFromMessageId)
          // A marker whose anchor is gone opens nothing, as in the loop's own view.
          if (at < 0) return []
          return [{ at, marker, details }]
        },
      }),
    )
    .sort((left, right) => left.at - right.at)

const windowOf = (
  session: Session,
  branchId: BranchId,
  index: number,
  segment: ReadonlyArray<Message>,
  cut: Option.Option<Cut>,
): Option.Option<ThreadWindow> =>
  Option.all([Option.fromUndefinedOr(segment[0]), Option.fromUndefinedOr(segment.at(-1))]).pipe(
    Option.map(([first, last]) => {
      const withText = (message: Message) => messageText(message).trim().length > 0
      const asked = segment.find((message) => message.role === "user" && withText(message))
      // A window that opens mid-turn has no ask of its own; its first spoken line stands in.
      const spoken = Option.fromUndefinedOr(asked).pipe(
        Option.orElse(() => Option.fromUndefinedOr(segment.find(withText))),
      )
      return {
        sessionId: session.id,
        branchId,
        sessionName: sessionLabel(session),
        index,
        firstMessageId: first.id,
        lastMessageId: last.id,
        count: segment.length,
        summary: Option.map(cut, (value) => summaryBody(messageText(value.marker))),
        summarizedCount: Option.match(cut, {
          onNone: () => 0,
          onSome: (value) =>
            Option.match(Option.fromUndefinedOr(value.details.summarized), {
              onNone: () => 0,
              onSome: (summarized) => summarized.count,
            }),
        }),
        omittedCount: 0,
        preview: Option.match(spoken, {
          onNone: () => "",
          onSome: (message) => firstLine(messageText(message)),
        }),
        updatedAt: last.createdAt.getTime(),
      }
    }),
  )

/**
 * The windows on one branch, oldest first. Every marker splits the branch at
 * its anchor; the segment after a marker is the window that marker opened.
 */
export const windowsOf = (
  session: Session,
  branchId: BranchId,
  messages: ReadonlyArray<Message>,
): ReadonlyArray<ThreadWindow> => {
  const markers = messages.filter((message) => Option.isSome(windowDetailsOf(message)))
  const body = messages.filter((message) => Option.isNone(windowDetailsOf(message)))
  const cuts = cutsOf(body, markers)
  const windows: Array<ThreadWindow> = []
  let start = 0
  let opener = Option.none<Cut>()
  for (const cut of cuts) {
    const window = windowOf(
      session,
      branchId,
      windows.length + 1,
      body.slice(start, cut.at),
      opener,
    )
    if (Option.isSome(window)) windows.push(window.value)
    start = cut.at
    opener = Option.some(cut)
  }
  const last = windowOf(session, branchId, windows.length + 1, body.slice(start), opener)
  if (Option.isSome(last)) windows.push(last.value)
  return windows
}

/**
 * Windows plus the load state, held in the setup closure so they survive the
 * pane closing. See `agents-view.client.tsx` for the same split.
 */
/** What one load produces: the chain length and the windows across it. */
interface Loaded {
  readonly sessions: number
  readonly windows: ReadonlyArray<ThreadWindow>
}

export interface ThreadController {
  readonly windows: () => ReadonlyArray<ThreadWindow>
  readonly sessions: () => number
  readonly current: () => Option.Option<{ sessionId: string; branchId: string }>
  readonly error: () => Option.Option<string>
  readonly loading: () => boolean
  readonly refresh: () => void
  readonly open: () => boolean
  readonly setOpen: (open: boolean) => void
}

export const makeThreadController = (
  fetchSessions: Effect.Effect<ReadonlyArray<Session>, { readonly message: string }>,
  fetchMessages: (
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<Message>, { readonly message: string }>,
  fetchOmitted: (active: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<number, { readonly message: string }>,
  cast: (effect: Effect.Effect<void>) => void,
  current: () => Option.Option<{ sessionId: SessionId; branchId: BranchId }>,
): ThreadController => {
  const [open, setOpen] = createSignal(false)

  /** The branch a session contributes: the shell's branch for its own session, else the active one. */
  const branchFor = (
    session: Session,
    active: { sessionId: SessionId; branchId: BranchId },
  ): Option.Option<BranchId> => {
    if (session.id === active.sessionId) return Option.some(active.branchId)
    return Option.fromUndefinedOr(session.activeBranchId)
  }

  const load = (active: { sessionId: SessionId; branchId: BranchId }) =>
    Effect.gen(function* () {
      const chain = threadChain(yield* fetchSessions, active.sessionId)
      const perSession = yield* Effect.forEach(chain, (session) =>
        Option.match(branchFor(session, active), {
          onNone: () => Effect.succeed<ReadonlyArray<ThreadWindow>>([]),
          onSome: (branchId) =>
            Effect.map(fetchMessages(branchId), (messages) =>
              windowsOf(session, branchId, messages),
            ),
        }),
      )
      const omitted = yield* fetchOmitted(active)
      const windows = perSession.flat()
      // The projection metric belongs to the live window: the last one on the shell's branch.
      const live = windows.findLastIndex((window) => window.branchId === active.branchId)
      return {
        sessions: chain.length,
        windows: windows.map((window, index) => {
          if (index !== live) return window
          return { ...window, omittedCount: omitted }
        }),
      }
    })

  // A compaction event refetches while the pane shows, and the shell can move
  // between the ask and the reply; the keyed query drops a reply whose session
  // is no longer the current one.
  const empty: Loaded = { sessions: 0, windows: [] }
  const loaded = makeClientSessionQuery({
    initial: empty,
    current,
    cast,
    fetch: (_query: "reload", session) => load(session),
  })

  return {
    windows: () => loaded.value().windows,
    sessions: () => loaded.value().sessions,
    current,
    error: loaded.error,
    loading: loaded.loading,
    refresh: () => loaded.refresh("reload"),
    open,
    setOpen,
  }
}

/** The list as drawn: a heading opens each session, windows keep their index for selection. */
export type ThreadItem =
  | { readonly kind: "heading"; readonly sessionName: string; readonly count: number }
  | { readonly kind: "window"; readonly window: ThreadWindow; readonly index: number }

export const threadItems = (windows: ReadonlyArray<ThreadWindow>): ReadonlyArray<ThreadItem> => {
  const items: Array<ThreadItem> = []
  windows.forEach((window, index) => {
    const previous = Option.fromUndefinedOr(windows[index - 1])
    if (Option.isNone(previous) || previous.value.sessionId !== window.sessionId) {
      const count = windows.filter((entry) => entry.sessionId === window.sessionId).length
      items.push({ kind: "heading", sessionName: window.sessionName, count })
    }
    items.push({ kind: "window", window, index })
  })
  return items
}

/** `window 3 · 12 messages · 7 summarized · 2 omitted · <preview>` */
export const windowLabel = (window: ThreadWindow): string => {
  const parts = [`window ${window.index}`, plural(window.count, "message")]
  if (window.summarizedCount > 0) parts.push(`${window.summarizedCount} summarized`)
  if (window.omittedCount > 0) parts.push(`${window.omittedCount} omitted`)
  if (window.preview.length > 0) parts.push(window.preview)
  return parts.join(" · ")
}

/** What the selected window opened with; the first window of a session has no summary. */
export const detailFor = (window: Option.Option<ThreadWindow>): string =>
  Option.match(window, {
    onNone: () => "",
    onSome: (value) =>
      Option.match(value.summary, {
        onNone: () => `${value.firstMessageId} … ${value.lastMessageId}`,
        onSome: (summary) => firstLine(summary),
      }),
  })

const emptyLabel = (loading: boolean): string => {
  if (loading) return "loading…"
  return "no windows"
}

export function ThreadPane(
  props: OverlayProps & {
    controller: ThreadController
    onSelect: (window: ThreadWindow) => void
  },
) {
  const { theme } = useTheme()
  const [cursor, setCursor] = createSignal(Option.none<ThreadWindow>())

  const windows = () => props.controller.windows()
  const isCurrent = (window: ThreadWindow): boolean =>
    Option.match(props.controller.current(), {
      onNone: () => false,
      onSome: (active) =>
        active.sessionId === window.sessionId && active.branchId === window.branchId,
    })

  const { rowWidth, sectionWidth } = ChromePanel.useDockGeometry()

  const marker = (window: ThreadWindow): string => {
    if (isCurrent(window) && window.index === windows().filter(isCurrent).length) return "› "
    return "  "
  }

  const rowLine = (window: ThreadWindow): string => {
    const age = formatAge(DateTime.toEpochMillis(DateTime.nowUnsafe()) - window.updatedAt)
    const width = Math.max(0, rowWidth() - age.length - 2)
    const left = `${marker(window)}  ${windowLabel(window)}`
    return `${truncate(left, width).padEnd(width)}  ${age}`
  }

  const rows = (): ReadonlyArray<SelectListRow<ThreadWindow>> =>
    threadItems(windows()).map((item) => {
      if (item.kind === "heading") {
        return decoration<ThreadWindow>(() => (
          <box paddingLeft={1}>
            <text style={{ fg: theme.textMuted }} wrapMode="none">
              {truncate(`${item.sessionName} (${plural(item.count, "window")})`, rowWidth())}
            </text>
          </box>
        ))
      }
      return selectable(item.window, (selected, id) => {
        const background = () => {
          if (selected()) return theme.primary
          return "transparent"
        }
        const color = () => {
          if (selected()) return theme.selectedListItemText
          if (isCurrent(item.window)) return theme.text
          return theme.textMuted
        }
        return (
          <box id={id} backgroundColor={background()} paddingLeft={1}>
            <text style={{ fg: color() }}>{rowLine(item.window)}</text>
          </box>
        )
      })
    })

  /** Open on the live window: the last one on the shell's own branch. */
  const sticky = (values: ReadonlyArray<ThreadWindow>): Option.Option<number> => {
    const live = values.findLastIndex(isCurrent)
    if (live >= 0) return Option.some(live)
    return Option.some(Math.max(0, values.length - 1))
  }

  const title = () =>
    `Thread · ${plural(props.controller.sessions(), "session")} · ${plural(windows().length, "window")}`

  return (
    <Show when={props.open}>
      <ChromePanel.Dock title={title()}>
        <SelectList
          id="thread"
          open={props.open}
          rows={rows}
          sticky={sticky}
          // The detail line below reads the row under the cursor; the list is
          // the only thing that knows where it is.
          onCursor={setCursor}
          empty={() => (
            <text style={{ fg: theme.textMuted }}>{emptyLabel(props.controller.loading())}</text>
          )}
          onSelect={props.onSelect}
          onDismiss={props.onClose}
        />

        <Show when={windows().length > 0}>
          <ChromePanel.Section>
            <text style={{ fg: theme.textMuted }}>
              {truncate(detailFor(cursor()), sectionWidth())}
            </text>
          </ChromePanel.Section>
        </Show>

        <ChromePanel.Error error={Option.getOrUndefined(props.controller.error())} />
        <ChromePanel.Footer>{"↑↓ move   ↵ open session   esc close"}</ChromePanel.Footer>
      </ChromePanel.Dock>
    </Show>
  )
}

export default defineClientExtension(THREAD_VIEW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    const controller = makeThreadController(
      transport.listSessions.pipe(Effect.mapError((error) => ({ message: error.message }))),
      (branchId) =>
        transport
          .listMessages(branchId)
          .pipe(Effect.mapError((error) => ({ message: error.message }))),
      (active) =>
        transport.agentDetail(active).pipe(
          Effect.map((detail) => detail.omittedMessages),
          Effect.mapError((error) => ({ message: error.message })),
        ),
      shell.cast,
      () =>
        Option.map(Option.fromNullishOr(transport.currentSession()), (active) => ({
          sessionId: active.sessionId,
          branchId: active.branchId,
        })),
    )

    // A handoff on the shell's branch opens a new window; re-read while showing.
    lifecycle.addCleanup(
      transport.onSessionEvent((envelope) => {
        const event = envelope.event
        if (event._tag !== "ModelContextProjected" || !event.compacted) return
        if (controller.open()) controller.refresh()
      }),
    )

    return clientContributions(
      clientCommandContribution({
        id: "thread.view",
        title: "Thread",
        description: "Show the sessions and context windows this session runs through",
        category: "Session",
        slash: "thread",
        onSelect: () => {
          controller.setOpen(true)
          controller.refresh()
        },
      }),
      widgetContribution({
        id: "thread.pane",
        slot: "below-input",
        component: () => (
          <ThreadPane
            open={controller.open()}
            controller={controller}
            onClose={() => controller.setOpen(false)}
            onSelect={(window) => {
              controller.setOpen(false)
              const active = controller.current()
              if (Option.isSome(active) && active.value.sessionId === window.sessionId) return
              shell.switchSession({
                sessionId: window.sessionId,
                branchId: window.branchId,
                name: window.sessionName,
              })
            }}
          />
        ),
      }),
    )
  }),
})
