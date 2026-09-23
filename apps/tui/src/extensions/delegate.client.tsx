/** @jsxImportSource @opentui/solid */
import {
  Effect,
  Fiber,
  FiberSet,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { createEffect, createMemo, createRoot, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  AgentEvent,
  AgentName,
  BranchId,
  EventEnvelope,
  Message,
  SessionId,
  ToolCallId,
} from "@gent/core/protocol"
import { omitUndefined, ref } from "@gent/core/extensions/api"
import type { DelegateChild } from "@gent/extensions/client.js"
import { DelegateRpc } from "@gent/extensions/client.js"
import { useTheme } from "../theme"
import { ToolFrame, useSpinnerClock } from "../ui"
import { formatUsageStats, toolArgSummary, type ToolInput } from "../utils"
import type { ToolRendererProps } from "../tool-renderers"
import {
  type ActiveExtensionSession,
  clientContributions,
  type ClientTransport,
  ClientContext,
  defineClientExtension,
  rendererContribution,
} from "./client-facets.js"

// ── builtins/delegate.client ────────────────────────────────────────────────

/**
 * The `delegate.start` row and the child runs under it.
 *
 * The delegate owns its roster (`DelegateRpc.Children`); core carries no
 * child-run events. This extension reads the roster for the branch the shell
 * is on, reads it again on every delegate state pulse, and follows each child
 * branch's own events for its tool calls and streamed text.
 */

/** The server delegate's id; the client module shares it by convention. */
const DELEGATE_EXTENSION_ID = ref(DelegateRpc.Children).extensionId

// ── child session tracker ───────────────────────────────────────────────────

/**
 * Reads the delegate roster for one parent branch, and every delegate
 * `ExtensionStateChanged` pulse re-reads it. A new row opens a per-child event
 * subscription for tool call and stream hydration; a row that turns terminal
 * drains the child's saved history once and closes its subscription. Entries
 * persist after completion. Closing the scope that built the tracker
 * interrupts every remaining subscription.
 */

/** Max chars retained in streamText to avoid unbounded memory growth */
const STREAM_TEXT_MAX_LENGTH = 2000

interface ChildToolCall {
  toolCallId: ToolCallId
  toolName: string
  status: "running" | "completed" | "error"
  input?: unknown
}

export interface ChildSessionEntry {
  childSessionId: SessionId
  childBranchId: BranchId
  toolCallId: ToolCallId
  agentName: AgentName
  status: "running" | "completed" | "error"
  toolCalls: ChildToolCall[]
  /** Accumulated stream text (live, during running) */
  streamText: string
  usage?: { input: number; output: number; cost?: number }
  preview?: string
}

export interface ChildSessionTrackerService {
  /** Start tracking children for a parent branch: read the roster, then re-read it on every pulse. */
  readonly track: (parent: ActiveExtensionSession) => Effect.Effect<void>
  /** Current children plus subsequent state snapshots for reactive consumers */
  readonly changes: Stream.Stream<ReadonlyMap<string, ChildSessionEntry>>
}

/** The pieces the tracker reads from, all delegate-owned or per-child. */
export interface ChildSessionTrackerDeps {
  /** One child branch's events from the start, for tool call and stream hydration. */
  readonly events: ClientTransport["sessionEvents"]
  /** The delegate registry for one parent branch, read as a client renders it. */
  readonly fetchChildren: (
    parent: ActiveExtensionSession,
  ) => Effect.Effect<ReadonlyArray<DelegateChild>>
  /** Subscribe to `ExtensionStateChanged` pulses; the tracker filters to the
   *  delegate and the parent it tracks. Returns an unsubscribe function. */
  readonly onExtensionStateChanged: (
    cb: (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void,
  ) => () => void
}

const projectChildEvent = (entry: ChildSessionEntry, event: AgentEvent): ChildSessionEntry => {
  switch (event._tag) {
    case "ToolCallStarted":
      return {
        ...entry,
        toolCalls: [
          ...entry.toolCalls,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "running",
            input: event.input,
          },
        ],
      }
    case "ToolCallSucceeded":
      return {
        ...entry,
        toolCalls: entry.toolCalls.map((tc): ChildToolCall => {
          if (tc.toolCallId === event.toolCallId) return { ...tc, status: "completed" }
          return tc
        }),
      }
    case "ToolCallFailed":
      return {
        ...entry,
        toolCalls: entry.toolCalls.map((tc): ChildToolCall => {
          if (tc.toolCallId === event.toolCallId) return { ...tc, status: "error" }
          return tc
        }),
      }
    case "StreamChunk":
      return {
        ...entry,
        streamText: (entry.streamText + event.chunk).slice(-STREAM_TEXT_MAX_LENGTH),
      }
    default:
      return entry
  }
}

export const makeChildSessionTracker = (
  deps: ChildSessionTrackerDeps,
): Effect.Effect<ChildSessionTrackerService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { events } = deps
    const trackerScope = yield* Effect.scope
    const entries = yield* SubscriptionRef.make(new Map<string, ChildSessionEntry>())
    const childFibers = yield* Ref.make(new Map<string, Fiber.Fiber<void>>())
    const fiberSet = yield* FiberSet.make<void>()

    const updateEntry = (
      childSessionId: string,
      f: (entry: ChildSessionEntry) => ChildSessionEntry,
    ) =>
      SubscriptionRef.modifySome(
        entries,
        (
          current,
        ): [Option.Option<ChildSessionEntry>, Option.Option<Map<string, ChildSessionEntry>>] => {
          const entry = Option.fromNullishOr(current.get(childSessionId))
          if (Option.isNone(entry)) return [Option.none(), Option.none()]
          const updated = f(entry.value)
          return [Option.some(updated), Option.some(new Map(current).set(childSessionId, updated))]
        },
      )

    const subscribeChild = (key: ActiveExtensionSession) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(fiberSet)(
          Stream.runForEach(events(key), (envelope: EventEnvelope) =>
            updateEntry(key.sessionId, (entry) => projectChildEvent(entry, envelope.event)),
          ).pipe(Effect.catchEager(() => Effect.void)),
        )
        yield* Ref.update(childFibers, (m) => new Map(m).set(key.sessionId, fiber))
      })

    const interruptChild = (childSessionId: string) =>
      Effect.gen(function* () {
        const fiber = yield* Ref.modify(
          childFibers,
          (fibers): [Option.Option<Fiber.Fiber<void>>, Map<string, Fiber.Fiber<void>>] => {
            const fiber = Option.fromNullishOr(fibers.get(childSessionId))
            if (Option.isNone(fiber)) return [Option.none(), fibers]
            const next = new Map(fibers)
            next.delete(childSessionId)
            return [fiber, next]
          },
        )
        if (Option.isSome(fiber)) {
          yield* Fiber.interrupt(fiber.value).pipe(Effect.catchEager(() => Effect.void))
        }
      })

    const finishChild = Effect.fn("ChildSessionTracker.finishChild")(function* (
      childSessionId: string,
    ) {
      yield* interruptChild(childSessionId)
      const current = Option.fromUndefinedOr(
        (yield* SubscriptionRef.get(entries)).get(childSessionId),
      )
      if (Option.isNone(current)) return
      const entry = current.value
      // A parent completion can arrive before the child's RPC replay finishes.
      // Fold the final durable history privately, then publish one complete snapshot.
      yield* events({ sessionId: entry.childSessionId, branchId: entry.childBranchId }).pipe(
        Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
        Stream.runFold(
          (): ChildSessionEntry => ({ ...entry, toolCalls: [], streamText: "" }),
          (state, envelope) => projectChildEvent(state, envelope.event),
        ),
        Effect.flatMap((snapshot) => updateEntry(childSessionId, () => snapshot)),
        Effect.catchEager((error) =>
          Effect.logWarning("Child event replay failed").pipe(
            Effect.annotateLogs({ childSessionId, error: String(error) }),
          ),
        ),
      )
    })

    // Reconcile one delegate registry row into the entries. A row with no
    // tool call has no delegate call the tool view could render it under,
    // so it is skipped. A new row opens a subscription; a row that has turned
    // terminal drains the child's saved history once, then closes it.
    const reconcileChild = (child: DelegateChild) =>
      Effect.gen(function* () {
        const toolCallId = Option.fromNullishOr(child.toolCallId)
        if (Option.isNone(toolCallId)) return
        const childId = child.sessionId

        const added = yield* SubscriptionRef.modifySome(
          entries,
          (current): [boolean, Option.Option<Map<string, ChildSessionEntry>>] => {
            const existing = Option.fromNullishOr(current.get(childId))
            if (Option.isNone(existing)) {
              const entry: ChildSessionEntry = {
                childSessionId: childId,
                childBranchId: child.branchId,
                toolCallId: toolCallId.value,
                agentName: child.agentName,
                status: child.status,
                toolCalls: [],
                streamText: "",
                ...omitUndefined({ usage: child.usage, preview: child.preview }),
              }
              return [true, Option.some(new Map(current).set(childId, entry))]
            }
            const next: ChildSessionEntry = {
              ...existing.value,
              status: child.status,
              ...omitUndefined({ usage: child.usage, preview: child.preview }),
            }
            return [false, Option.some(new Map(current).set(childId, next))]
          },
        )
        if (added) yield* subscribeChild({ sessionId: childId, branchId: child.branchId })
        // `finishChild` is idempotent: a second pulse for an already-finished
        // row finds no subscription and re-folds the same state.
        if (child.status !== "running") yield* finishChild(childId)
      })

    const reconcileRoster = (parent: ActiveExtensionSession) =>
      deps
        .fetchChildren(parent)
        .pipe(
          Effect.flatMap((children) => Effect.forEach(children, reconcileChild, { discard: true })),
        )

    const service: ChildSessionTrackerService = {
      track: (parent) =>
        Effect.gen(function* () {
          // A pulse fires on a client thread and cannot yield, so it offers the
          // parent onto a queue that a scoped fiber drains into a roster read.
          const pulses = yield* Queue.make<ActiveExtensionSession>()
          yield* FiberSet.run(fiberSet)(
            Queue.take(pulses).pipe(
              Effect.flatMap((tracked) =>
                reconcileRoster(tracked).pipe(Effect.catchEager(() => Effect.void)),
              ),
              Effect.forever,
            ),
          )

          const unsubscribe = deps.onExtensionStateChanged((pulse) => {
            if (pulse.extensionId !== DELEGATE_EXTENSION_ID) return
            if (pulse.sessionId !== parent.sessionId) return
            if (pulse.branchId !== parent.branchId) return
            Queue.offerUnsafe(pulses, parent)
          })
          yield* Scope.addFinalizer(trackerScope, Effect.sync(unsubscribe))

          // Seed the roster once so children spawned before this session was
          // mounted show up without waiting for the next pulse.
          yield* reconcileRoster(parent).pipe(Effect.catchEager(() => Effect.void))
        }),

      changes: SubscriptionRef.changes(entries),
    }

    return service
  })

// ── roster for the shell's branch ───────────────────────────────────────────

/** The child runs of the branch the shell is on, by the delegate call that started them. */
interface DelegateChildren {
  readonly forToolCall: (toolCallId: string) => ReadonlyArray<ChildSessionEntry>
}

/**
 * One tracker per branch the shell is on. `currentSession` moves only when the
 * session or the branch does, so a rename or a model change keeps the rows the
 * tracker holds. A move closes the old tracker and its subscriptions.
 */
export const trackDelegateChildren = Effect.gen(function* () {
  const { transport, lifecycle } = yield* ClientContext
  const [store, setStore] = createStore<{ entries: Record<string, ChildSessionEntry> }>({
    entries: {},
  })
  const moves = yield* Queue.unbounded<Option.Option<ActiveExtensionSession>>()
  createRoot((dispose) => {
    lifecycle.addCleanup(dispose)
    createEffect(on(transport.currentSession, (session) => Queue.offerUnsafe(moves, session)))
  })

  const rosterFor = (
    parent: ActiveExtensionSession,
  ): Stream.Stream<ReadonlyMap<string, ChildSessionEntry>> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tracker = yield* makeChildSessionTracker({
          events: transport.sessionEvents,
          fetchChildren: (branch) =>
            transport
              .request(ref(DelegateRpc.Children), {}, branch)
              .pipe(
                Effect.catchEager(() => Effect.succeed([] satisfies ReadonlyArray<DelegateChild>)),
              ),
          onExtensionStateChanged: transport.onExtensionStateChanged,
        })
        yield* tracker.track(parent)
        return tracker.changes
      }),
    )

  yield* lifecycle.scoped(
    Effect.forkScoped(
      Stream.fromQueue(moves).pipe(
        Stream.switchMap((session) =>
          Option.match(session, {
            onNone: () => Stream.make(new Map<string, ChildSessionEntry>()),
            onSome: rosterFor,
          }),
        ),
        Stream.runForEach((entries) =>
          Effect.sync(() => setStore({ entries: Object.fromEntries(entries) })),
        ),
      ),
    ),
  )

  const children: DelegateChildren = {
    forToolCall: (toolCallId) =>
      Object.values(store.entries).filter((entry) => entry.toolCallId === toolCallId),
  }
  return children
})

// ── tool call tree ──────────────────────────────────────────────────────────

interface ToolCallInfo {
  toolName: string
  args: Schema.JsonObject
  isError: boolean
  status?: "running" | "completed" | "error"
}

const SPINNER_FRAMES = ["·", "•", "*"]

const decodeArgs = Schema.decodeUnknownOption(Schema.JsonObject)

const toolCallInfo = (tc: ChildToolCall): ToolCallInfo => ({
  toolName: tc.toolName,
  args: Option.getOrElse(decodeArgs(tc.input), () => ({})),
  isError: tc.status === "error",
  status: tc.status,
})

function ToolCallTree(props: { toolCalls: ReadonlyArray<ToolCallInfo>; collapsed?: boolean }) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()

  const hiddenCount = () => {
    if (!props.collapsed) return 0
    return Math.max(0, props.toolCalls.length - 10)
  }

  const visible = () => {
    const calls = props.toolCalls
    if (hiddenCount() > 0) return calls.slice(calls.length - 10)
    return calls
  }

  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={hiddenCount() > 0}>
        <text style={{ fg: theme.textMuted }}>├── … {hiddenCount()} earlier calls</text>
      </Show>
      <For each={[...visible()]}>
        {(call, index) => {
          const isLast = () => index() === visible().length - 1
          const connector = () => {
            if (isLast()) return "╰──"
            return "├──"
          }
          const icon = () => {
            if (call.status === "running") {
              return Option.getOrElse(
                Option.fromNullishOr(SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]),
                () => "·",
              )
            }
            if (call.isError || call.status === "error") return "✕"
            return "✓"
          }
          const iconColor = () => {
            if (call.status === "running") return theme.warning
            if (call.isError || call.status === "error") return theme.error
            return theme.textMuted
          }
          const summary = () => toolArgSummary(call.toolName, call.args)
          const summaryText = () => {
            if (summary().length > 0) return ` ${summary()}`
            return ""
          }

          return (
            <text style={{ fg: theme.textMuted }}>
              {connector()} <span style={{ fg: iconColor() }}>{icon()}</span> {call.toolName}
              {summaryText()}
            </text>
          )
        }}
      </For>
    </box>
  )
}

// ── live child tree ─────────────────────────────────────────────────────────

function LiveChildTree(props: { childRuns: ReadonlyArray<ChildSessionEntry> }) {
  const { theme } = useTheme()

  const statusColor = (status: ChildSessionEntry["status"]) => {
    if (status === "running") return theme.warning
    if (status === "error") return theme.error
    return theme.success
  }

  const statusIcon = (status: ChildSessionEntry["status"]) => {
    if (status === "running") return "⋯"
    if (status === "error") return "✕"
    return "✓"
  }

  return (
    <For each={[...props.childRuns]}>
      {(entry) => (
        <box flexDirection="column">
          <text style={{ fg: theme.textMuted }}>
            <span style={{ fg: statusColor(entry.status) }}>{statusIcon(entry.status)}</span>{" "}
            {entry.agentName}
          </text>
          <ToolCallTree toolCalls={entry.toolCalls.map(toolCallInfo)} />
        </box>
      )}
    </For>
  )
}

// ── delegate renderer ───────────────────────────────────────────────────────

/**
 * The `delegate.start` renderer.
 *
 * Collapsed: tool call tree (last 10) + usage stats
 * Expanded:
 *   - Running: live tool calls + streaming text
 *   - Completed: full tool call tree + usage + thinking + message text
 *   - Fallback: toolCall.output/preview when message fetch unavailable
 */

const decodeDelegateInput = Schema.decodeUnknownOption(
  Schema.Struct({
    todo: Schema.optional(Schema.String),
  }),
)

/** The delegated task, cut to 60 columns, as the header subtitle. */
const delegateSubtitle = (input: ToolInput): Option.Option<string> => {
  const todo = decodeDelegateInput(input).pipe(
    Option.flatMap((inp) => Option.fromNullishOr(inp.todo)),
  )
  if (Option.isNone(todo)) return Option.none()
  if (todo.value.length > 60) return Option.some(todo.value.slice(0, 60) + "…")
  return todo
}

interface ChildContent {
  readonly reasoning: string[]
  readonly text: string[]
}

/** Extract reasoning + text parts from child session messages */
const extractChildContent = (messages: ReadonlyArray<Message>): ChildContent => {
  const reasoning: string[] = []
  const text: string[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type === "reasoning") reasoning.push(part.text)
      else if (part.type === "text") text.push(part.text)
    }
  }
  return { reasoning, text }
}

interface DelegateRendererProps extends ToolRendererProps {
  readonly childRuns: ReadonlyArray<ChildSessionEntry>
  /** The finished child's answer, read once its call settles. */
  readonly readContent: (branchId: BranchId, write: (content: ChildContent) => void) => void
}

function DelegateToolRenderer(props: DelegateRendererProps) {
  const { theme } = useTheme()

  const hasChildren = () => props.childRuns.length > 0
  const completedChild = (): Option.Option<ChildSessionEntry> => {
    if (props.childRuns.length !== 1) return Option.none()
    return Option.fromNullishOr(props.childRuns[0])
  }

  // Aggregate tool calls from all child sessions for the tree view
  const allToolCalls = createMemo(() =>
    props.childRuns.flatMap((child) => child.toolCalls.map(toolCallInfo)),
  )

  // Aggregate usage across all children
  const totalUsage = createMemo(() => {
    let input = 0
    let output = 0
    let cost = 0
    let hasUsage = false
    for (const child of props.childRuns) {
      const usage = Option.fromNullishOr(child.usage)
      if (Option.isSome(usage)) {
        hasUsage = true
        input += usage.value.input
        output += usage.value.output
        cost += Option.getOrElse(Option.fromNullishOr(usage.value.cost), () => 0)
      }
    }
    if (!hasUsage) return Option.none<string>()
    return Option.some(
      formatUsageStats({
        input,
        output,
        cost: Option.getOrUndefined(Option.liftPredicate(cost, (value) => value > 0)),
      }),
    )
  })

  // Live stream text — bounded tail from all children
  const liveText = createMemo(() =>
    props.childRuns
      .map((child) => child.streamText)
      .filter((text) => text.length > 0)
      .join("\n"),
  )

  // Read the child's structured answer (reasoning + text) once the call settles.
  const [childMessages, setChildMessages] = createSignal<Option.Option<ChildContent>>(Option.none())
  // The key memo holds its value across equal reads, so one branch is read once.
  const settledBranch = createMemo(
    (): Option.Option<BranchId> => {
      if (props.toolCall.status === "running") return Option.none()
      return Option.map(completedChild(), (child) => child.childBranchId)
    },
    Option.none(),
    { equals: Option.makeEquivalence<BranchId>((left, right) => left === right) },
  )
  createEffect(
    on(settledBranch, (branchId) => {
      if (Option.isNone(branchId)) return
      props.readContent(branchId.value, (content) => setChildMessages(Option.some(content)))
    }),
  )
  const answer = () =>
    childMessages().pipe(
      Option.filter((content) => content.reasoning.length > 0 || content.text.length > 0),
    )

  // Fallback text from toolCall.output or child preview
  const fallbackText = () => {
    if (Option.isSome(answer())) return Option.none<string>()
    const preview = Option.flatMap(completedChild(), (child) => Option.fromNullishOr(child.preview))
    if (Option.isSome(preview)) return preview
    return Option.orElse(Option.fromNullishOr(props.toolCall.output), () =>
      Option.fromNullishOr(props.toolCall.summary),
    )
  }

  return (
    <ToolFrame
      title="delegate"
      subtitle={Option.getOrUndefined(delegateSubtitle(props.toolCall.input))}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <box flexDirection="column">
          <Show when={hasChildren()}>
            <ToolCallTree toolCalls={allToolCalls()} collapsed />
          </Show>
          <Show when={Option.getOrUndefined(totalUsage())}>
            {(line) => <text style={{ fg: theme.textMuted }}>{line()}</text>}
          </Show>
        </box>
      }
    >
      {/* Running: live tool calls + streaming text */}
      <Show when={props.toolCall.status === "running" && hasChildren()}>
        <box flexDirection="column">
          <LiveChildTree childRuns={props.childRuns} />
          <Show when={liveText().length > 0}>
            <text style={{ fg: theme.textMuted }}>
              <i>{liveText()}</i>
            </text>
          </Show>
        </box>
      </Show>

      <Show when={props.toolCall.status === "running" && !hasChildren()}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Running…
        </text>
      </Show>

      {/* Completed: tool tree + usage + messages */}
      <Show when={props.toolCall.status !== "running" && hasChildren()}>
        <box flexDirection="column">
          <ToolCallTree toolCalls={allToolCalls()} />
          <Show when={Option.getOrUndefined(totalUsage())}>
            {(line) => <text style={{ fg: theme.textMuted }}>{line()}</text>}
          </Show>
        </box>
      </Show>

      {/* Structured messages from child session (fetched on completion) */}
      <Show when={Option.getOrUndefined(answer())}>
        {(content) => (
          <box flexDirection="column" marginTop={1}>
            <For each={content().reasoning}>
              {(r) => (
                <text>
                  <span style={{ fg: theme.textMuted }}>
                    <i>{r}</i>
                  </span>
                </text>
              )}
            </For>
            <For each={content().text}>{(t) => <text style={{ fg: theme.text }}>{t}</text>}</For>
          </box>
        )}
      </Show>

      {/* Fallback: preview/output when message fetch unavailable */}
      <Show when={props.toolCall.status !== "running" && Option.getOrUndefined(fallbackText())}>
        {(text) => (
          <text style={{ fg: theme.textMuted }} marginTop={1}>
            {text()}
          </text>
        )}
      </Show>
    </ToolFrame>
  )
}

// ── extension ───────────────────────────────────────────────────────────────

export default defineClientExtension(DELEGATE_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, shell } = yield* ClientContext
    const children = yield* trackDelegateChildren
    // A failed read leaves the fallback line (preview or tool output) up.
    const readContent = (branchId: BranchId, write: (content: ChildContent) => void) =>
      shell.cast(
        transport.listMessages(branchId).pipe(
          Effect.flatMap((messages) => Effect.sync(() => write(extractChildContent(messages)))),
          Effect.ignore,
        ),
      )
    return clientContributions(
      rendererContribution(["delegate.start"], (props) => (
        <DelegateToolRenderer
          {...props}
          childRuns={children.forToolCall(props.toolCall.id)}
          readContent={readContent}
        />
      )),
    )
  }),
})
