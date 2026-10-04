import { Effect, Option, Predicate, Record, Schema } from "effect"
import {
  type AuthProviderInfo,
  Branch,
  type BranchId,
  type Model,
  ModelId,
  ReasoningEffort,
  type SessionAdmission,
  SessionId,
  type GentClientRpcError,
  type GentNamespacedClient,
  type QueueEntryInfo,
  Session as DomainSession,
} from "@gent/core/protocol"
import { type Session as ClientSession, useClient } from "./client"
import { formatCost, formatDuration, isConversation, randomId, truncate } from "./utils"
import { textWidth } from "./bun-adapter"
import { createMemo, createSignal, ErrorBoundary, For, type JSX, Show } from "solid-js"
import { buildSyntaxStyle, resolveThemeColor, ThemeProvider, useTheme } from "./theme"
import {
  KeyboardScopeProvider,
  useCopyOnSelect,
  useScopedKeyboard,
  useTerminalDimensions,
} from "./terminal"
import type { RGBA } from "@opentui/core"
import { MessageList, NativeTranscript, splitFooterHeight } from "./message-list"
import { Composer, ComposerFrame, StatusRow } from "./composer"
import {
  DockFooter,
  DockProvider,
  KEY_HINT_SEPARATOR,
  keyHint,
  KeyHints,
  keyHintsLine,
  useDockPaneOpen,
  useDockSpacer,
} from "./ui"
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
import { useWorkspace } from "./workspace"
import {
  type StatusRowLabel,
  buildContextLabels,
  buildModelLabels,
  createSessionController,
  formatCwdGit,
  overlayHoldsComposer,
  SessionControllerContext,
  useExit,
} from "./session"
import { ExtensionRenderBoundary, useExtensionUI } from "./extensions/host"
import { Auth, providerLabel } from "./auth"
import type {
  MessageRendererEntry,
  StatusLabelAnchor,
  StatusLabelColor,
  WidgetSlot,
} from "./extensions/client-facets.js"

// ── boot flow ───────────────────────────────────────────────────────────────

/**
 * Why the interactive or headless start could not resolve its session: a
 * corrupt record (no `activeBranchId`), a missing session or prompt. A typed
 * failure, so the CLI prints its one line instead of a stack trace.
 */
export class AppBootstrapError extends Schema.TaggedError<AppBootstrapError>()(
  "AppBootstrapError",
  {
    sessionId: Schema.optional(SessionId),
    reason: Schema.Literals([
      "created-session-unreadable",
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
      case "headless-missing-prompt":
        return "Headless startup requires a prompt argument"
      case "missing-branch":
        return `Session ${sessionLabel} has no branch — cannot render`
      case "session-not-found":
        return `Session ${sessionLabel} not found`
    }
  }
}

/** Where the interactive start lands: the session, or its branch picker when it has more than one branch. */
const InteractiveState = Schema.Union([
  Schema.TaggedStruct("session", {
    session: DomainSession,
    prompt: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("branchPicker", {
    session: DomainSession,
    branches: Schema.Array(Branch),
    prompt: Schema.optionalKey(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
type InteractiveState = Schema.Schema.Type<typeof InteractiveState>

/** The session a headless run sends its one prompt to. */
export interface HeadlessState {
  readonly session: DomainSession
  readonly prompt: string
}

interface AppBootstrap {
  readonly initialSession: ClientSession
  readonly initialPrompt: Option.Option<string>
  /**
   * The branches to resume from, when the session the startup flags picked
   * has more than one. The session view mounts on the active branch and docks
   * the picker over it; `None` means resume straight into the session.
   */
  readonly initialBranches: Option.Option<readonly Branch[]>
}

/** The session view's record; none for a record with no active branch to mount. */
const toSession = (session: DomainSession): Option.Option<ClientSession> => {
  const branchId = Option.fromNullishOr(session.activeBranchId)
  if (Option.isNone(branchId)) return Option.none()
  return Option.some({
    sessionId: session.id,
    branchId: branchId.value,
    name: Option.getOrElse(Option.fromNullishOr(session.name), () => "Unnamed"),
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    cwd: session.cwd,
  })
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
  state: InteractiveState,
): Effect.Effect<AppBootstrap, AppBootstrapError> => {
  // A created session always has its branch. A corrupt record from `-s <id>`
  // may not, and the view (and a picker docked over it) needs one to mount.
  const initialSession = toSession(state.session)
  if (Option.isNone(initialSession)) {
    return Effect.fail(
      new AppBootstrapError({ sessionId: state.session.id, reason: "missing-branch" }),
    )
  }
  let initialBranches = Option.none<readonly Branch[]>()
  if (state._tag === "branchPicker") initialBranches = Option.some(state.branches)
  return Effect.succeed({
    initialSession: initialSession.value,
    initialPrompt: Option.fromNullishOr(state.prompt),
    initialBranches,
  })
}

export const resolveInteractiveBootstrap = (input: {
  client: Pick<GentNamespacedClient, "branch" | "session">
  cwd: string
  sessionId?: string
  continue_: boolean
  prompt?: string
}): Effect.Effect<AppBootstrap, GentClientRpcError | AppBootstrapError> =>
  // The session view reads its agent from the snapshot it loads anyway.
  resolveInteractiveState({
    client: input.client,
    cwd: input.cwd,
    session: Option.fromNullishOr(input.sessionId),
    continue_: input.continue_,
    prompt: Option.fromNullishOr(input.prompt),
  }).pipe(Effect.flatMap(resolveAppBootstrap))

/**
 * The sign-ins the headless run's agent is missing: each required provider
 * with no credential, by the label `/auth` shows (`providerLabel`).
 * A headless run has no reader to sign in, so it stops before its turn.
 */
export const resolveHeadlessMissingSignIns = (input: {
  client: Pick<GentNamespacedClient, "auth">
  state: HeadlessState
}): Effect.Effect<ReadonlyArray<string>, GentClientRpcError> =>
  Effect.gen(function* () {
    // The session id names the agent the session runs, and its cwd resolves
    // project-level driver overrides.
    const providers = yield* input.client.auth.listProviders({
      sessionId: input.state.session.id,
    })
    return providers
      .filter((provider) => provider.required && !provider.hasKey)
      .map((provider) => providerLabel(providers, provider.provider))
  })

/** The stored session `-s` names, or the startup error that it does not exist. */
const loadSession = (
  client: Pick<GentNamespacedClient, "session">,
  id: string,
): Effect.Effect<DomainSession, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const sessionId = SessionId.make(id)
    const stored = Option.fromNullishOr(yield* client.session.get({ sessionId }))
    if (Option.isNone(stored)) {
      return yield* new AppBootstrapError({ sessionId, reason: "session-not-found" })
    }
    return stored.value
  })

/** Resume a session: straight in with one branch, through the branch picker with more. */
const resumeState = (
  client: Pick<GentNamespacedClient, "branch">,
  session: DomainSession,
  prompt: Option.Option<string>,
): Effect.Effect<InteractiveState, GentClientRpcError> =>
  Effect.gen(function* () {
    const promptText = Option.getOrUndefined(prompt)
    const branches = yield* client.branch.list({ sessionId: session.id })
    if (branches.length > 1) {
      return {
        _tag: "branchPicker",
        session,
        branches,
        prompt: promptText,
      } satisfies InteractiveState
    }
    return { _tag: "session", session, prompt: promptText } satisfies InteractiveState
  })

/** The session `-H` runs its prompt in: the one `-s` names, else a new one. */
export const resolveHeadlessState = (input: {
  client: Pick<GentNamespacedClient, "session">
  cwd: string
  session: Option.Option<string>
  promptArg: Option.Option<string>
  /** The agent and run spec a new headless session runs as, for every turn. */
  admission?: SessionAdmission
}): Effect.Effect<HeadlessState, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const { client, cwd, session, promptArg, admission } = input
    if (Option.isNone(promptArg) || promptArg.value.trim().length === 0) {
      return yield* new AppBootstrapError({ reason: "headless-missing-prompt" })
    }
    if (Option.isSome(session)) {
      return { session: yield* loadSession(client, session.value), prompt: promptArg.value }
    }
    return {
      session: yield* createAndLoadSession({ client, cwd, admission }),
      prompt: promptArg.value,
    }
  })

/** The session the TUI opens: the one `-s` names, the last one in `cwd` to continue, else a new one. */
export const resolveInteractiveState = (input: {
  client: Pick<GentNamespacedClient, "session" | "branch">
  cwd: string
  session: Option.Option<string>
  continue_: boolean
  prompt: Option.Option<string>
}): Effect.Effect<InteractiveState, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const { client, cwd, session, continue_, prompt } = input

    if (Option.isSome(session)) {
      return yield* resumeState(client, yield* loadSession(client, session.value), prompt)
    }

    if (continue_) {
      const existing = yield* client.session.list().pipe(
        Effect.map((sessions) =>
          Option.fromNullishOr(
            sessions
              .filter((candidate) => candidate.cwd === cwd)
              .filter(isConversation)
              .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0],
          ),
        ),
      )
      if (Option.isSome(existing)) return yield* resumeState(client, existing.value, prompt)
      // No existing session for cwd — fall through to create one
    }

    const promptText = Option.getOrUndefined(prompt)
    const created = yield* createAndLoadSession({ client, cwd })
    return { _tag: "session", session: created, prompt: promptText } satisfies InteractiveState
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
  const connectionIssue = () => client.connectionIssue()
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
  /** The message renderers, whose `queueLabel` names a waiting message of their type. */
  messageRenderers: ReadonlyMap<string, MessageRendererEntry>
}

function summaryText(text: string): string {
  const lines = text.split("\n")
  const first = lines[0] ?? ""
  if (lines.length <= 1) return first
  return `${first} +${lines.length - 1} lines`
}

/**
 * The line a waiting message shows: its type's `queueLabel` (a background
 * answer as `↳ answer · <question>`), else the first line of its text.
 */
const queueEntryLine = (
  entry: QueueEntryInfo,
  renderers: ReadonlyMap<string, MessageRendererEntry>,
): string => {
  const metadata = Option.fromUndefinedOr(entry.metadata)
  return metadata.pipe(
    Option.flatMap((value) => Option.fromUndefinedOr(value.customType)),
    Option.flatMap((type) => Option.fromUndefinedOr(renderers.get(type))),
    Option.flatMap((renderer) => Option.fromUndefinedOr(renderer.queueLabel)),
    Option.match({
      onNone: () => summaryText(entry.content),
      onSome: (label) =>
        label({
          content: entry.content,
          details: Option.getOrUndefined(Option.map(metadata, (value) => value.details)),
        }),
    }),
  )
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
              <span style={{ fg: theme.text }}>
                {" "}
                {queueEntryLine(message, props.messageRenderers)}
              </span>
            </text>
          )}
        </For>
        <For each={props.queuedMessages}>
          {(message, index) => (
            <text>
              <span style={{ fg: theme.textMuted }}>┋ [queued {index() + 1}]</span>
              <span style={{ fg: theme.text }}>
                {" "}
                {queueEntryLine(message, props.messageRenderers)}
              </span>
            </text>
          )}
        </For>
        <text style={{ fg: theme.textMuted }}> {keyHintsLine([KeyHints.restoreQueue], 80)}</text>
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
  /** The model is scripted (`--debug`, `--mock-empty`): it needs no sign-in. */
  scriptedModel?: boolean
}

function ExtensionWidgets(props: { slot: WidgetSlot }) {
  const ext = useExtensionUI()
  const slotWidgets = () => ext.widgets().filter((w) => w.slot === props.slot)

  return (
    <For each={slotWidgets()}>
      {(widget) => {
        const Widget = widget.component
        return (
          <ExtensionRenderBoundary extensionId={widget.extensionId}>
            <Widget />
          </ExtensionRenderBoundary>
        )
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

/**
 * The model as the status row names it: its name, and its provider's label
 * (`providerLabel`) when another provider's model has the same name, so the
 * row says which provider runs, and bills, the next turn.
 */
export const statusModelName = (
  model: Model,
  models: ReadonlyArray<Model>,
  providers: ReadonlyArray<AuthProviderInfo>,
): string => {
  const shared = models.some(
    (other) => other.name === model.name && other.provider !== model.provider,
  )
  if (!shared) return model.name
  return `${model.name} (${providerLabel(providers, model.provider)})`
}

/**
 * The activity row while a turn runs: what it does, how long it has run, and
 * the way out. Too narrow, the elapsed time goes first, then the label cuts;
 * the way out stays.
 */
export const activityLine = (label: string, elapsed: string, width: number): string => {
  const hint = `${KEY_HINT_SEPARATOR}${keyHintsLine([KeyHints.cancel], width)}`
  if (textWidth(label + elapsed + hint) <= width) return label + elapsed + hint
  return truncate(label, Math.max(1, width - textWidth(hint))) + hint
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
  const paneOpen = useDockPaneOpen()
  // The sign-in docks in the footer like every pane. It stays mounted while
  // its overlay is open, so the flow it is in survives other UI updates.
  const authOverlay = () => {
    const overlay = controller.uiState().overlay
    if (overlay._tag === "auth") return Option.some(overlay)
    return Option.none()
  }

  // Map semantic color names from extensions to resolved theme colors
  const resolveColor = (color: StatusLabelColor): RGBA => resolveThemeColor(theme, color)

  /** The extension status labels of one group, by priority. */
  const extensionLabels = (anchor: StatusLabelAnchor): StatusRowLabel[] =>
    ext
      .statusLabelItems(anchor)
      .map((item) => ({ text: item.text, color: resolveColor(item.color) }))

  const connectionLabels = (): StatusRowLabel[] => {
    const items: StatusRowLabel[] = []

    // Core chrome: connection/restart status
    const restart = Option.filter(client.connectedGeneration(), (generation) => generation > 0)
    if (client.isReconnecting()) {
      items.push({ text: "reconnecting", color: theme.warning })
    } else if (Option.isSome(restart)) {
      items.push({ text: `restart ${restart.value}`, color: theme.textMuted })
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
    return [{ text: formatCost(c), color: theme.textMuted }]
  }

  const modelLabels = (): StatusRowLabel[] => {
    const model = client.modelInfo()
    const items: StatusRowLabel[] = []
    if (Option.isSome(model))
      items.push({
        text: statusModelName(model.value, client.models(), controller.authProviders()),
        color: theme.textMuted,
      })
    return items.concat(
      buildModelLabels({
        reasoningLevel: client.reasoningLevel(),
        theme,
        debugMode: props.debugMode === true,
      }),
    )
  }

  /**
   * The labels anchored to the right edge: the right-anchored extension
   * labels (the cache timer), the context gauge and the running total. Each
   * is a number a reader checks at a glance without reading the row, so they
   * hold their place and the left group truncates instead. An empty label
   * takes no place in the count.
   */
  const rightAnchoredLabels = (): StatusRowLabel[] =>
    [
      ...extensionLabels("right"),
      ...buildContextLabels({
        metrics: client.sessionMetrics(),
        model: client.modelInfo(),
        theme,
      }),
      ...costLabels(),
    ].filter((label) => label.text.length > 0)

  const phaseLabels = (): StatusRowLabel[] => {
    const a = controller.activity()
    const items: StatusRowLabel[] = []
    if (controller.uiState().transcriptExpanded) {
      items.push({
        text: `transcript · ${keyHintsLine([KeyHints.close], 80)}`,
        color: theme.textMuted,
      })
    }
    // One footer line, one owner. An armed key's cue (`ctrl+c again to exit`)
    // comes first: it answers the key just pressed and lasts a second. A
    // local error (a slash command that could not apply, a failed RPC)
    // replaces the phase word until the next turn clears it; an extension
    // notice shows when no error stands, and a notice never replaces an error.
    const armedCue = controller.armedCue()
    const localError = client.error()
    const notice = client.notice()
    if (Option.isSome(armedCue)) {
      items.push({ text: armedCue.value, color: theme.warning })
    } else if (Option.isSome(localError)) {
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
    const sessionCwd = client.pathPlace().cwd
    const atLaunchCwd = sessionCwd === workspace.cwd
    items.push({
      text: formatCwdGit(
        sessionCwd,
        Option.filter(workspace.gitRoot(), () => atLaunchCwd),
        Option.filter(workspace.gitBranch(), () => atLaunchCwd),
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
          streaming={client.isStreaming()}
          footerHeight={footerHeight()}
          paneOpen={paneOpen()}
          expanded={controller.uiState().transcriptExpanded}
          disclosure={controller.uiState().disclosure}
          displayRevision={controller.uiState().displayRevision}
          overlayOpen={command.paletteOpen() || overlayHoldsComposer(controller.uiState().overlay)}
          renderItems={(items) => (
            <MessageList
              items={items}
              disclosure={controller.uiState().disclosure}
              fullDetail={controller.uiState().transcriptExpanded}
              syntaxStyle={syntaxStyle}
            />
          )}
        >
          <Show when={controller.items().length === 0}>
            <box height={1} flexShrink={0}>
              <text>
                <span style={{ fg: theme.primary, bold: true }}>gent</span>
                <span style={{ fg: theme.textMuted }}>
                  {" "}
                  · {keyHintsLine([keyHint("ctrl+p", "commands")], 80)}
                </span>
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
            messageRenderers={ext.messageRenderers()}
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
                  const label = controller.phaseLabel()
                  let elapsed = ""
                  if (controller.elapsed() >= 1000)
                    elapsed = ` (${formatDuration(controller.elapsed(), "compact")})`
                  return activityLine(label, elapsed, Math.max(1, dimensions().width - 2))
                })()}
              </text>
            </ActivityRow>
          </Show>

          {/* One dock slot: every pane (the popup and the palette inside the
            composer, the panes after it) docks under the status row. */}
          <ComposerFrame>
            <Composer
              statusRow={
                <StatusRow
                  labels={[
                    ...phaseLabels(),
                    ...connectionLabels(),
                    ...modelLabels(),
                    ...extensionLabels("left"),
                    ...rightAnchoredLabels(),
                  ]}
                  rightLabels={rightAnchoredLabels().length}
                />
              }
            >
              <Composer.Autocomplete />
              <CommandPalette />
            </Composer>
          </ComposerFrame>
          <SettingsPicker
            open={controller.uiState().overlay._tag === "model"}
            title="Model"
            rows={modelRows(client.models())}
            current={Option.some(client.model())}
            // No models yet is not none: the session's catalog still loads.
            detail={Option.match(client.modelCatalog(), {
              onNone: () => Option.some("Loading the session's models…"),
              onSome: () => Option.none(),
            })}
            onSelect={(id) => controller.onModelSelect(ModelId.make(id))}
            onClose={controller.closeOverlay}
          />
          <SettingsPicker
            open={controller.uiState().overlay._tag === "reasoning"}
            title="Reasoning"
            rows={reasoningRows(client.resolvedReasoningLevel())}
            current={Option.some(
              Option.getOrElse(
                Option.fromUndefinedOr(client.session().reasoningLevel),
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
      </box>
    </SessionControllerContext.Provider>
  )
}

// ── app shell ───────────────────────────────────────────────────────────────

interface AppProps {
  debugMode?: boolean
  /** The model is scripted (`--debug`, `--mock-empty`): it needs no sign-in. */
  scriptedModel?: boolean
  initialThemeMode?: "dark" | "light"
  /**
   * Branches the boot flow resumed into, when the session has more than one.
   * The session mounts on its active branch and docks the picker over it.
   */
  initialBranches?: Option.Option<readonly Branch[]>
}

function AppContent(props: AppProps) {
  useCopyOnSelect()

  // Which session shows is the client's to say. `switchSession` is the one
  // writer, and every pane that moves the reader between sessions goes
  // through it, so the session view mounts keyed on it.
  const sessionClient = useClient()
  //
  // The key is the identity, not the session record: a new name or a new model
  // makes a new record, and a mount keyed on the record would tear the whole
  // session view down for it. `sessionIdentity` is the client's one answer to
  // "which session"; every consumer that does not read the name shares it.
  const active = sessionClient.sessionIdentity

  // The boot picker belongs to the first session this process mounts. A later
  // switch is a session the reader already chose, so it docks nothing.
  //
  // Read once and remember the answer: Solid re-reads a prop every time the
  // child touches it, so a getter that consumes the branches would hand the
  // first read `Some` and every read after it `None`.
  // No computation reads it: the keyed child runs untracked, once per mount.
  let bootBranches = Option.getOrElse(Option.fromNullishOr(props.initialBranches), () =>
    Option.none<readonly Branch[]>(),
  )

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Show when={active()} keyed>
        {(session) => {
          const branches = bootBranches
          bootBranches = Option.none()
          return (
            <Session
              sessionId={session.sessionId}
              branchId={session.branchId}
              initialBranches={branches}
              debugMode={props.debugMode}
              scriptedModel={props.scriptedModel}
            />
          )
        }}
      </Show>
    </box>
  )
}

const decodeError = Schema.decodeUnknownOption(Schema.instanceOf(Error))

/**
 * What a render throw leaves on screen. The session view is gone with its
 * keys, so this screen keeps one way out: ctrl+c or ctrl+d exits. The error
 * goes to the client log with its stack, since the screen shows only the
 * message.
 */
function FatalScreen(props: { readonly error: unknown }) {
  const exit = useExit()
  const client = useClient()
  const cause = decodeError(props.error)
  const message = Option.match(cause, {
    onNone: () => String(props.error),
    onSome: (error) => error.message,
  })
  client.log.error("app.fatal", {
    error: message,
    stack: Option.getOrElse(
      Option.flatMap(cause, (error) => Option.fromNullishOr(error.stack)),
      () => "",
    ),
  })
  useScopedKeyboard((event) => {
    if (event.ctrl !== true || (event.name !== "c" && event.name !== "d")) return false
    // A crash is when the reader most needs the session id: exit prints it.
    exit()
    return true
  })
  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <text>
        <span style={{ fg: "red", bold: true }}>Fatal error</span>
      </text>
      <text>{message}</text>
      <text>{keyHintsLine([KeyHints.exit], 80)}</text>
    </box>
  )
}

export function App(props: AppProps) {
  return (
    <ErrorBoundary
      fallback={(error) => (
        <KeyboardScopeProvider>
          <FatalScreen error={error} />
        </KeyboardScopeProvider>
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
