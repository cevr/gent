import { Effect, Match, Option, Predicate, Record, Schema } from "effect"
import {
  type AgentName,
  type Branch,
  type BranchId,
  DEFAULT_AGENT_NAME,
  ModelId,
  type ProviderId,
  ReasoningEffort,
  type SessionAdmission,
  SessionId,
  type GentClientRpcError,
  type GentNamespacedClient,
  type QueueEntryInfo,
  type Session as DomainSession,
} from "@gent/core/protocol"
import { type Session as ClientSession, useClient } from "./client"
import { formatDuration, randomId, truncate } from "./utils"
import { createMemo, createSignal, ErrorBoundary, For, type JSX, Show } from "solid-js"
import { buildSyntaxStyle, resolveThemeColor, ThemeProvider, useTheme } from "./theme"
import { KeyboardScopeProvider, useScopedKeyboard, useTerminalDimensions } from "./terminal"
import type { RGBA } from "@opentui/core"
import { MessageList, NativeTranscript, splitFooterHeight } from "./message-list"
import { Composer, ComposerFrame } from "./composer"
import { DockFooter, DockProvider, useDockSpacer } from "./ui"
import { CommandPalette, CommandProvider, useCommand } from "./commands"
import {
  BranchPicker,
  DEFAULT_ROW_ID,
  MessagePicker,
  modelRows,
  PromptSearchPalette,
  reasoningRows,
  SettingsPicker,
} from "./pickers"
import { collectDiagrams, MermaidViewer } from "./mermaid"
import { useEnv, useWorkspace } from "./workspace"
import {
  type StatusRowLabel,
  buildContextLabels,
  buildModelLabels,
  createSessionController,
  formatCwdGit,
  overlayHoldsComposer,
  SessionControllerContext,
} from "./session"
import { useExtensionUI } from "./extensions/host"
import { Auth } from "./auth"
import type { StatusLabelColor, WidgetSlot } from "./extensions/client-facets.js"
import { useRenderer } from "@opentui/solid"

// ── boot flow ───────────────────────────────────────────────────────────────

/**
 * Surfaces a corrupt session record (session row exists but has no
 * `activeBranchId`). Caught at the bootstrap boundary in `main.tsx`
 * so the user sees a structured error message instead of a stack
 * trace. Thrown synchronously because `resolveAppBootstrap` is a
 * synchronous projection at the render boundary.
 */
export class AppBootstrapError extends Schema.TaggedError<AppBootstrapError>()(
  "AppBootstrapError",
  {
    sessionId: Schema.optional(SessionId),
    reason: Schema.Literals([
      "created-session-unreadable",
      "interactive-headless-state",
      "headless-missing-prompt",
      "missing-branch",
      "session-not-found",
    ]),
  },
) {
  override get message(): string {
    const sessionLabel = Option.getOrElse(Option.fromNullishOr(this.sessionId), () => "unknown")
    switch (this.reason) {
      case "created-session-unreadable":
        return `Created session ${sessionLabel} was not readable`
      case "interactive-headless-state":
        return "Interactive bootstrap resolved a headless state"
      case "headless-missing-prompt":
        return "Headless startup requires a prompt argument"
      case "missing-branch":
        return `Session ${sessionLabel} has no branch — cannot render`
      case "session-not-found":
        return `Session ${sessionLabel} not found`
    }
  }
}

export type InitialState =
  | { _tag: "session"; session: DomainSession; prompt?: string }
  | {
      _tag: "branchPicker"
      session: DomainSession
      branches: readonly Branch[]
      prompt?: string
    }
  | { _tag: "headless"; session: DomainSession; prompt: string }

interface AppBootstrap {
  // eslint-disable-next-line effect/noNullish -- bootstrap API uses absence when no session is selected.
  readonly initialSession: ClientSession | undefined
  readonly initialPrompt: Option.Option<string>
  /**
   * The branches to resume from, when the session the startup flags picked
   * has more than one. The session view mounts on the active branch and docks
   * the picker over it; `None` means resume straight into the session.
   */
  readonly initialBranches: Option.Option<readonly Branch[]>
  readonly debugMode: boolean
}

interface InteractiveBootstrapResult {
  readonly bootstrap: AppBootstrap
  // eslint-disable-next-line effect/noNullish -- bootstrap API uses absence for headless startup.
  readonly initialAgent: AgentName | undefined
}

// eslint-disable-next-line effect/noNullish -- bootstrap projection returns absence for an unreadable branch.
const toSession = (session: DomainSession): ClientSession | undefined => {
  const branchId = Option.fromNullishOr(session.activeBranchId)
  if (Option.isNone(branchId)) return Option.getOrUndefined(Option.none<ClientSession>())
  return {
    sessionId: session.id,
    branchId: branchId.value,
    name: Option.getOrElse(Option.fromNullishOr(session.name), () => "Unnamed"),
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    cwd: session.cwd,
  }
}

const createAndLoadSession = (input: {
  client: Pick<GentNamespacedClient, "session">
  cwd: string
  admission?: SessionAdmission
}): Effect.Effect<DomainSession, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const requestId = yield* randomId
    const result = yield* input.client.session.create({
      cwd: input.cwd,
      requestId,
      ...Record.filter({ admission: input.admission }, Predicate.isNotUndefined),
    })
    const session = yield* input.client.session.get({ sessionId: result.sessionId })
    const decodedSession = Option.fromNullishOr(session)
    if (Option.isNone(decodedSession)) {
      return yield* new AppBootstrapError({
        sessionId: result.sessionId,
        reason: "created-session-unreadable",
      })
    }
    return decodedSession.value
  })

const resolveAppBootstrap = (
  state: Exclude<InitialState, { _tag: "headless" }>,
  options: {
    debugMode: boolean
  },
): AppBootstrap =>
  Match.value(state).pipe(
    Match.tagsExhaustive({
      session: (state) => {
        // activeBranchId is always present for sessions created by resolveInitialState.
        // Guard for corrupt session records from -s <id> with missing branch.
        const branchId = Option.fromNullishOr(state.session.activeBranchId)
        if (Option.isNone(branchId)) {
          // eslint-disable-next-line effect/noThrowStatement -- synchronous render-boundary validation must throw.
          throw new AppBootstrapError({ sessionId: state.session.id, reason: "missing-branch" })
        }
        return {
          initialSession: toSession(state.session),
          initialPrompt: Option.fromNullishOr(state.prompt),
          initialBranches: Option.none<readonly Branch[]>(),
          debugMode: options.debugMode,
        }
      },
      branchPicker: (state) => {
        // Same guard as `session`: the picker docks over a mounted session, so
        // a record with no active branch has nothing to mount under it.
        const branchId = Option.fromNullishOr(state.session.activeBranchId)
        if (Option.isNone(branchId)) {
          // eslint-disable-next-line effect/noThrowStatement -- synchronous render-boundary validation must throw.
          throw new AppBootstrapError({ sessionId: state.session.id, reason: "missing-branch" })
        }
        return {
          initialSession: toSession(state.session),
          initialPrompt: Option.fromNullishOr(state.prompt),
          initialBranches: Option.some(state.branches),
          debugMode: options.debugMode,
        }
      },
    }),
  )

export const resolveInteractiveBootstrap = (input: {
  client: Pick<GentNamespacedClient, "branch" | "session">
  cwd: string
  sessionId?: string
  continue_: boolean
  prompt?: string
  debugMode: boolean
}): Effect.Effect<InteractiveBootstrapResult, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const state = yield* resolveInitialState({
      client: input.client,
      cwd: input.cwd,
      session: Option.fromNullishOr(input.sessionId),
      continue_: input.continue_,
      headless: false,
      prompt: Option.fromNullishOr(input.prompt),
      promptArg: Option.none(),
    })

    if (state._tag === "headless") {
      return yield* new AppBootstrapError({ reason: "interactive-headless-state" })
    }

    const initialAgent = yield* resolveStartupAgent({ client: input.client, state })

    return {
      bootstrap: resolveAppBootstrap(state, { debugMode: input.debugMode }),
      initialAgent: Option.getOrUndefined(initialAgent),
    }
  })

const resolveSessionRuntimeAgent = (
  client: Pick<GentNamespacedClient, "session">,
  session: DomainSession,
): Effect.Effect<Option.Option<AgentName>, GentClientRpcError> => {
  const branchId = Option.fromNullishOr(session.activeBranchId)
  if (Option.isNone(branchId)) return Effect.succeedNone
  return client.session
    .getSnapshot({
      sessionId: session.id,
      branchId: branchId.value,
    })
    .pipe(Effect.map((snapshot) => Option.some(snapshot.agent)))
}

/** A session runs as its own agent, which its snapshot names; one with no branch yet runs the default. */
const sessionAgent = (
  client: Pick<GentNamespacedClient, "session">,
  session: DomainSession,
): Effect.Effect<AgentName, GentClientRpcError> =>
  resolveSessionRuntimeAgent(client, session).pipe(
    Effect.map(Option.getOrElse(() => DEFAULT_AGENT_NAME)),
  )

/**
 * The agent the interactive client starts as: the resumed session's own. The
 * boot branch picker names none, because the reader has not chosen a branch.
 * The session view's auth gate checks that agent's providers itself.
 */
export const resolveStartupAgent = (input: {
  client: Pick<GentNamespacedClient, "session">
  state: Exclude<InitialState, { _tag: "headless" }>
}): Effect.Effect<Option.Option<AgentName>, GentClientRpcError> => {
  if (input.state._tag === "branchPicker") return Effect.succeedNone
  return sessionAgent(input.client, input.state.session).pipe(Effect.asSome)
}

/**
 * The required providers the headless run's agent has no credential for. A
 * headless run has no reader to sign in, so it stops before its turn.
 */
export const resolveHeadlessMissingProviders = (input: {
  client: Pick<GentNamespacedClient, "auth" | "session">
  state: Extract<InitialState, { _tag: "headless" }>
}): Effect.Effect<readonly ProviderId[], GentClientRpcError> =>
  Effect.gen(function* () {
    const agent = yield* sessionAgent(input.client, input.state.session)
    // The session id lets its cwd resolve project-level driver overrides.
    const providers = yield* input.client.auth.listProviders({
      agentName: agent,
      sessionId: input.state.session.id,
    })
    return providers
      .filter((provider) => provider.required && !provider.hasKey)
      .map((provider) => provider.provider)
  })

export const resolveInitialState = (input: {
  client: Pick<GentNamespacedClient, "session" | "branch">
  cwd: string
  session: Option.Option<string>
  continue_: boolean
  headless: boolean
  prompt: Option.Option<string>
  promptArg: Option.Option<string>
  /** The agent and run spec a new headless session runs as, for every turn. */
  admission?: SessionAdmission
}): Effect.Effect<InitialState, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const { client, cwd, session, continue_, headless, prompt, promptArg, admission } = input

    if (headless) {
      if (Option.isNone(promptArg) || promptArg.value.trim().length === 0) {
        return yield* new AppBootstrapError({ reason: "headless-missing-prompt" })
      }
      if (Option.isSome(session)) {
        const sessionId = SessionId.make(session.value)
        const sess = yield* client.session.get({ sessionId })
        const decodedSession = Option.fromNullishOr(sess)
        if (Option.isNone(decodedSession)) {
          return yield* new AppBootstrapError({ sessionId, reason: "session-not-found" })
        }
        return {
          _tag: "headless",
          session: decodedSession.value,
          prompt: promptArg.value,
        } satisfies InitialState
      }

      const created = yield* createAndLoadSession({ client, cwd, admission })
      return {
        _tag: "headless",
        session: created,
        prompt: promptArg.value,
      } satisfies InitialState
    }

    if (Option.isSome(session)) {
      const sessionId = SessionId.make(session.value)
      const sess = yield* client.session.get({ sessionId })
      const decodedSession = Option.fromNullishOr(sess)
      if (Option.isNone(decodedSession)) {
        return yield* new AppBootstrapError({ sessionId, reason: "session-not-found" })
      }
      const promptText = Option.getOrUndefined(prompt)
      const branches = yield* client.branch.list({ sessionId: decodedSession.value.id })
      if (branches.length > 1) {
        return {
          _tag: "branchPicker",
          session: decodedSession.value,
          branches,
          prompt: promptText,
        } satisfies InitialState
      }
      return {
        _tag: "session",
        session: decodedSession.value,
        prompt: promptText,
      } satisfies InitialState
    }

    if (continue_) {
      const existing = yield* client.session.list().pipe(
        Effect.map((sessions) =>
          Option.fromNullishOr(
            sessions
              .filter((candidate) => candidate.cwd === cwd)
              // A delegate or `/btw` child has a parent and its own thread.
              // It is the agent's work, not a conversation the user left.
              .filter(
                (candidate) =>
                  Predicate.isUndefined(candidate.parentSessionId) ||
                  candidate.threadId !== candidate.id,
              )
              .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0],
          ),
        ),
      )
      if (Option.isSome(existing)) {
        const existingSession = existing.value
        const promptText = Option.getOrUndefined(prompt)
        const branches = yield* client.branch.list({ sessionId: existingSession.id })
        if (branches.length > 1) {
          return {
            _tag: "branchPicker",
            session: existingSession,
            branches,
            prompt: promptText,
          } satisfies InitialState
        }
        return {
          _tag: "session",
          session: existingSession,
          prompt: promptText,
        } satisfies InitialState
      }
      // No existing session for cwd — fall through to create one
    }

    const promptText = Option.getOrUndefined(prompt)
    const created = yield* createAndLoadSession({ client, cwd })
    return { _tag: "session", session: created, prompt: promptText } satisfies InitialState
  })

// ── connection widget ───────────────────────────────────────────────────────

/**
 * Host chrome: connection issues and extensions that failed to load. It reads
 * the host's own contexts, so it is not an extension, and no extension id can
 * disable or shadow the report of failed extensions.
 */

export function ConnectionWidget() {
  const client = useClient()
  const ext = useExtensionUI()
  const { theme } = useTheme()
  const connectionIssue = () => Option.fromNullishOr(client.connectionIssue())
  const degradedExtensions = () => {
    const health = client.extensionHealth()
    if (health._tag === "Degraded") return health.degradedExtensions
    return []
  }
  // Each failed extension with its reason: an id alone ("config") does not
  // say which file broke or why.
  const failedExtensions = () => [
    ...degradedExtensions().flatMap((extension) =>
      extension.issues
        .filter((issue) => issue._tag === "ActivationFailed")
        .map((issue) => `${extension.manifest.id}: ${issue.error}`),
    ),
    ...ext.failures().map((failure) => `${failure.id}: ${failure.reason}`),
  ]
  const unavailableCatalogs = () =>
    degradedExtensions().flatMap((extension) =>
      extension.issues
        .filter((issue) => issue._tag === "ModelCatalogFailed")
        .map((issue) => `${issue.driverId}: ${issue.error}`),
    )
  const hasFailedExtensions = () => failedExtensions().length > 0
  // Reconnecting and the restart count belong to the status row;
  // this widget draws what the label cannot: issues and failed extensions.
  const hasUnavailableCatalogs = () => unavailableCatalogs().length > 0
  const visible = () =>
    Option.isSome(connectionIssue()) || hasFailedExtensions() || hasUnavailableCatalogs()
  const accent = () => {
    if (hasFailedExtensions() || hasUnavailableCatalogs()) return theme.warning
    return theme.error
  }
  const subtitle = () => {
    if (hasFailedExtensions()) return "extension activation degraded"
    if (hasUnavailableCatalogs()) return "some models unavailable"
    return Option.getOrElse(connectionIssue(), () => "")
  }
  return (
    <Show when={visible()}>
      <box flexDirection="column" paddingLeft={2} marginTop={1} marginBottom={1}>
        <text>
          <span style={{ fg: accent(), bold: true }}>• connection</span>
          <span style={{ fg: theme.textMuted }}> · {subtitle()}</span>
        </text>
        <box flexDirection="column" paddingLeft={2}>
          <Show when={Option.isSome(connectionIssue())}>
            <text>
              <span style={{ fg: theme.text }}>{Option.getOrUndefined(connectionIssue())}</span>
            </text>
          </Show>
          <Show when={hasFailedExtensions()}>
            <text>
              <span style={{ fg: theme.text }}>failed extensions:</span>
            </text>
            <For each={failedExtensions()}>
              {(line) => (
                <text paddingLeft={2}>
                  <span style={{ fg: theme.textMuted }}>{line}</span>
                </text>
              )}
            </For>
          </Show>
          <Show when={hasUnavailableCatalogs()}>
            <text>
              <span style={{ fg: theme.text }}>model catalogs that did not load:</span>
            </text>
            <For each={unavailableCatalogs()}>
              {(line) => (
                <text paddingLeft={2}>
                  <span style={{ fg: theme.textMuted }}>{line}</span>
                </text>
              )}
            </For>
          </Show>
        </box>
      </box>
    </Show>
  )
}

// ── queue widget ────────────────────────────────────────────────────────────

interface QueueWidgetProps {
  queuedMessages: readonly QueueEntryInfo[]
  steerMessages: readonly QueueEntryInfo[]
}

function summaryText(text: string): string {
  const lines = text.split("\n")
  const first = lines[0] ?? ""
  if (lines.length <= 1) return first
  return `${first} +${lines.length - 1} lines`
}

export function QueueWidget(props: QueueWidgetProps) {
  const { theme } = useTheme()

  const hasItems = () => props.queuedMessages.length > 0 || props.steerMessages.length > 0

  return (
    <Show when={hasItems()}>
      <box flexDirection="column" paddingLeft={2} marginBottom={1}>
        <For each={props.steerMessages}>
          {(message, index) => (
            <text>
              <span style={{ fg: theme.textMuted }}>┋ [steer {index() + 1}]</span>
              <span style={{ fg: theme.text }}> {summaryText(message.content)}</span>
            </text>
          )}
        </For>
        <For each={props.queuedMessages}>
          {(message, index) => (
            <text>
              <span style={{ fg: theme.textMuted }}>┋ [queued {index() + 1}]</span>
              <span style={{ fg: theme.text }}> {summaryText(message.content)}</span>
            </text>
          )}
        </For>
        <text style={{ fg: theme.textMuted }}> cmd+up restore</text>
      </box>
    </Show>
  )
}

// ── session view ────────────────────────────────────────────────────────────

/**
 * Session route - message list, composer, streaming
 */

interface SessionProps {
  sessionId: SessionId
  branchId: BranchId
  /** Branches to dock the picker over at boot; `None` resumes straight in. */
  initialBranches: Option.Option<readonly Branch[]>
  debugMode?: boolean
}

function ExtensionWidgets(props: { slot: WidgetSlot }) {
  const ext = useExtensionUI()
  const slotWidgets = () => ext.widgets().filter((w) => w.slot === props.slot)

  return (
    <For each={slotWidgets()}>
      {(widget) => {
        const Widget = widget.component
        return <Widget />
      }}
    </For>
  )
}

/** The "Generating" row. Its blank row above gives way while a docked pane is short. */
function ActivityRow(props: { children: JSX.Element }) {
  const spacer = useDockSpacer()
  return (
    <box height={1} flexShrink={0} paddingLeft={2} marginTop={spacer()} overflow="hidden">
      {props.children}
    </box>
  )
}

/** A reasoning row id; `default` decodes to `None` and clears the override. */
const parseReasoningRow = Schema.decodeUnknownOption(ReasoningEffort)

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const command = useCommand()
  const dimensions = useTerminalDimensions()
  const workspace = useWorkspace()
  const controller = createSessionController(props)
  const client = useClient()
  const ext = useExtensionUI()

  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))
  const [footerHeight, setFooterHeight] = createSignal(4)
  // The sign-in docks in the footer like every pane. It stays mounted while
  // its overlay is open, so the flow it is in survives other UI updates.
  const authOverlay = () => {
    const overlay = controller.uiState().overlay
    if (overlay._tag === "auth") return Option.some(overlay)
    return Option.none()
  }
  const mermaidDiagrams = createMemo(() => {
    if (controller.uiState().overlay._tag === "mermaid") {
      return collectDiagrams(controller.messages(), dimensions().width)
    }
    return []
  })

  // Map semantic color names from extensions to resolved theme colors
  const resolveColor = (color: StatusLabelColor): RGBA => resolveThemeColor(theme, color)

  /** Every extension status label, by priority, after the host's own. */
  const extensionLabels = (): StatusRowLabel[] =>
    ext
      .statusLabels()
      .flatMap((label) =>
        label.produce().map((item) => ({ text: item.text, color: resolveColor(item.color) })),
      )

  const connectionLabels = (): StatusRowLabel[] => {
    const items: StatusRowLabel[] = []

    // Core chrome: connection/restart status
    const conn = client.connectionState()
    if (client.isReconnecting()) {
      items.push({ text: "reconnecting", color: theme.warning })
    } else if (conn?._tag === "Connected" && conn.generation > 0) {
      items.push({ text: `restart ${conn.generation}`, color: theme.textMuted })
    }

    return items
  }

  /**
   * The running total, rendered last of everything.
   *
   * Cost is the one number a reader glances at
   * without reading the rest of the row, so it belongs at the far end where
   * its position is fixed and nothing before it can shift it.
   */
  const costLabels = (): StatusRowLabel[] => {
    const c = client.cost()
    if (c <= 0) return []
    return [{ text: `$${c.toFixed(2)}`, color: theme.textMuted }]
  }

  const modelLabels = (): StatusRowLabel[] => {
    const model = Option.fromNullishOr(client.modelInfo())
    const items: StatusRowLabel[] = []
    if (Option.isSome(model)) items.push({ text: model.value.name, color: theme.textMuted })
    return items.concat(
      buildModelLabels({
        reasoningLevel: Option.fromNullishOr(client.reasoningLevel()),
        theme,
        debugMode: props.debugMode === true,
      }),
    )
  }

  /**
   * The labels anchored to the right edge: the context gauge and the running
   * total. Both are numbers a reader checks at a glance without reading the
   * row, so they hold their place and the left group truncates instead.
   */
  const rightAnchoredLabels = (): StatusRowLabel[] =>
    buildContextLabels({
      metrics: client.sessionMetrics(),
      model: Option.fromNullishOr(client.modelInfo()),
      theme,
    }).concat(costLabels())

  const phaseLabels = (): StatusRowLabel[] => {
    const a = controller.activity()
    const items: StatusRowLabel[] = []
    if (controller.uiState().transcriptExpanded) {
      items.push({ text: "transcript · Esc to return", color: theme.textMuted })
    }
    // One footer line, one owner. A local error (a slash command that could
    // not apply, a failed RPC) replaces the phase word until the next turn
    // clears it; an extension notice shows when no error stands, and a
    // notice never replaces an error.
    const localError = Option.fromNullishOr(client.error())
    const notice = client.notice()
    if (Option.isSome(localError)) {
      items.push({ text: localError.value, color: theme.error })
    } else if (Option.isSome(notice)) {
      items.push({ text: notice.value, color: theme.warning })
    } else if (a.phase === "idle") {
      items.push({ text: controller.phaseLabel(), color: theme.textMuted })
    }

    // Where the session is rooted, beside the phase word rather than behind a
    // debug flag. A reader running several sessions at once cannot tell them
    // apart from the model and cost alone, and the cwd is the thing that
    // distinguishes them.
    // The git facts are the launch directory's; a session rooted elsewhere
    // shows its directory alone rather than borrow them.
    const sessionCwd = Option.getOrElse(
      Option.flatMap(Option.fromNullishOr(client.session()), (session) =>
        Option.fromUndefinedOr(session.cwd),
      ),
      () => workspace.cwd,
    )
    const atLaunchCwd = sessionCwd === workspace.cwd
    items.push({
      text: formatCwdGit(
        sessionCwd,
        Option.filter(Option.fromNullishOr(workspace.gitRoot()), () => atLaunchCwd),
        Option.filter(Option.fromNullishOr(workspace.gitStatus()?.branch), () => atLaunchCwd),
      ),
      color: theme.textMuted,
    })

    return items
  }

  return (
    <SessionControllerContext.Provider value={controller}>
      <box flexDirection="column" flexGrow={1}>
        {/* Messages */}
        <NativeTranscript
          items={controller.items()}
          settled={controller.itemsSettled()}
          streaming={controller.activity().phase !== "idle"}
          footerHeight={footerHeight()}
          expanded={controller.uiState().transcriptExpanded}
          disclosure={controller.uiState().disclosure}
          displayRevision={controller.uiState().displayRevision}
          overlayOpen={command.paletteOpen() || overlayHoldsComposer(controller.uiState().overlay)}
          renderItems={(items, streaming) => (
            <MessageList
              items={items}
              disclosure={controller.uiState().disclosure}
              fullDetail={controller.uiState().transcriptExpanded}
              syntaxStyle={syntaxStyle}
              streaming={streaming}
            />
          )}
        >
          <Show when={controller.items().length === 0}>
            <box height={1} flexShrink={0}>
              <text>
                <span style={{ fg: theme.primary, bold: true }}>gent</span>
                <span style={{ fg: theme.textMuted }}> · Ctrl+P for commands</span>
              </text>
            </box>
          </Show>
          <ConnectionWidget />
          <ExtensionWidgets slot="below-messages" />
          {/* QueueWidget stays hardwired because its data comes from session controller
              state that is not exposed through the extension context. */}
          <QueueWidget
            queuedMessages={controller.queueState().followUp}
            steerMessages={controller.queueState().steering}
          />
        </NativeTranscript>

        {/* The footer never outgrows the split-footer region: past it, the
            last rows (a docked pane's newest lines, its ask line) fall below
            the terminal. While a docked pane is open the trays hide
            (`TrayFrame`), the blank rows give way (`useDockSpacer`), and the
            pane gives way in whole rows (`PickerFrame`); the composer keeps
            its rows. */}
        <DockFooter
          maxHeight={splitFooterHeight(dimensions().height, dimensions().height)}
          onSizeChange={setFooterHeight}
        >
          <ExtensionWidgets slot="above-input" />

          <Show when={controller.activity().phase !== "idle"}>
            <ActivityRow>
              <text wrapMode="none" style={{ fg: theme.textMuted }}>
                {(() => {
                  let label = "Generating"
                  if (controller.activity().phase === "tool") label = controller.phaseLabel()
                  if (controller.elapsed() >= 1000)
                    label += ` (${formatDuration(controller.elapsed(), "compact")})`
                  return truncate(label, Math.max(1, dimensions().width - 2))
                })()}
              </text>
            </ActivityRow>
          </Show>

          <ComposerFrame
            labels={[
              ...phaseLabels(),
              ...connectionLabels(),
              ...modelLabels(),
              ...extensionLabels(),
              ...rightAnchoredLabels(),
            ]}
            rightLabels={rightAnchoredLabels().length}
          >
            <Composer>
              <Composer.Autocomplete />
              <CommandPalette />
            </Composer>
          </ComposerFrame>
          <SettingsPicker
            open={controller.uiState().overlay._tag === "model"}
            title="Model"
            rows={modelRows(client.models())}
            current={Option.some(client.model())}
            onSelect={(id) => controller.onModelSelect(ModelId.make(id))}
            onClose={controller.closeOverlay}
          />
          <SettingsPicker
            open={controller.uiState().overlay._tag === "reasoning"}
            title="Reasoning"
            rows={reasoningRows(client.resolvedReasoningLevel())}
            current={Option.some(
              Option.getOrElse(
                Option.fromUndefinedOr(client.session()?.reasoningLevel),
                () => DEFAULT_ROW_ID,
              ),
            )}
            onSelect={(id) => controller.onReasoningSelect(parseReasoningRow(id))}
            onClose={controller.closeOverlay}
          />
          {(() => {
            const overlay = controller.uiState().overlay
            if (overlay._tag !== "branches") return <></>
            return (
              <BranchPicker
                open={true}
                sessionId={props.sessionId}
                sessionName={controller.currentSessionName()}
                branches={overlay.branches}
                onSelect={controller.onBranchPickerSelect}
                onClose={controller.onBranchPickerDismiss}
              />
            )
          })()}
          <MessagePicker
            open={controller.uiState().overlay._tag === "fork"}
            messages={controller.forkMessages()}
            onSelect={controller.onForkSelect}
            onClose={controller.closeOverlay}
          />
          <PromptSearchPalette
            state={controller.promptSearch.state()}
            entries={controller.promptSearch.entries()}
            onEvent={controller.promptSearch.onEvent}
          />
          <Show when={Option.getOrUndefined(authOverlay())}>
            {(overlay) => (
              <Auth
                sessionId={props.sessionId}
                enforceAuth={overlay().enforceAuth}
                onResolved={controller.resolveAuthGate}
                onClose={controller.closeOverlay}
              />
            )}
          </Show>
          <ExtensionWidgets slot="below-input" />
        </DockFooter>

        <MermaidViewer
          open={controller.uiState().overlay._tag === "mermaid"}
          diagrams={mermaidDiagrams()}
          onClose={controller.closeOverlay}
        />
      </box>
    </SessionControllerContext.Provider>
  )
}

// ── app shell ───────────────────────────────────────────────────────────────

interface AppProps {
  debugMode?: boolean
  initialThemeMode?: "dark" | "light"
  /**
   * Branches the boot flow resumed into, when the session has more than one.
   * The session mounts on its active branch and docks the picker over it.
   */
  initialBranches?: Option.Option<readonly Branch[]>
}

function AppContent(props: AppProps) {
  const renderer = useRenderer()
  const env = useEnv()
  useScopedKeyboard((event) => {
    if (event.ctrl !== true || event.name !== "c") return false
    renderer.destroy()
    env.shutdown()
    return true
  })

  // Which session shows is the client's to say. `switchSession` is the one
  // writer, and every pane that moves the reader between sessions goes
  // through it, so the session view mounts keyed on it.
  const sessionClient = useClient()
  //
  // The key is the identity, not the session record: a new name or a new model
  // makes a new record, and a mount keyed on the record would tear the whole
  // session view down for it. `sessionIdentity` is the client's one answer to
  // "which session"; every consumer that does not read the name shares it.
  const active = () => Option.getOrUndefined(sessionClient.sessionIdentity())

  // The boot picker belongs to the first session this process mounts. A later
  // switch is a session the reader already chose, so it docks nothing.
  //
  // Read once and remember the answer: Solid re-reads a prop every time the
  // child touches it, so a getter that consumes the branches would hand the
  // first read `Some` and every read after it `None`.
  const [bootBranches, setBootBranches] = createSignal(
    Option.getOrElse(Option.fromNullishOr(props.initialBranches), () =>
      Option.none<readonly Branch[]>(),
    ),
  )

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Show when={active()} keyed fallback={<CommandPalette />}>
        {(session) => {
          const branches = bootBranches()
          setBootBranches(Option.none())
          return (
            <Session
              sessionId={session.sessionId}
              branchId={session.branchId}
              initialBranches={branches}
              debugMode={props.debugMode}
            />
          )
        }}
      </Show>
    </box>
  )
}

export function App(props: AppProps) {
  const decodeError = Schema.decodeUnknownOption(Schema.instanceOf(Error))
  const errorMessage = (error: Parameters<typeof decodeError>[0]): string =>
    Option.match(decodeError(error), {
      onNone: () => String(error),
      onSome: (cause) => cause.message,
    })

  return (
    <ErrorBoundary
      fallback={(err) => (
        <box flexDirection="column" paddingLeft={1} paddingTop={1}>
          <text>
            <span style={{ fg: "red", bold: true }}>Fatal error</span>
          </text>
          <text>{errorMessage(err)}</text>
        </box>
      )}
    >
      <ThemeProvider mode={props.initialThemeMode}>
        <KeyboardScopeProvider>
          <DockProvider>
            <CommandProvider>
              <AppContent {...props} />
            </CommandProvider>
          </DockProvider>
        </KeyboardScopeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
