import { Effect, Option, Predicate, Record, Schema } from "effect"
import {
  type AuthProviderInfo,
  Branch,
  type BranchId,
  type Model,
  ModelId,
  EffortSetting,
  type SessionAdmission,
  SessionId,
  type GentClientRpcError,
  type GentNamespacedClient,
  type QueueEntryInfo,
  Session as DomainSession,
} from "@gent/core/protocol"
import { type Session as ClientSession, useClient, useRuntime } from "./client"
import { formatCost, formatDuration, isConversation, plural, randomId, truncate } from "./utils"
import type { DisclosureLevel } from "./extensions/client-facets"
import { textWidth } from "./bun-adapter"
import { createEffect, createMemo, createSignal, ErrorBoundary, For, on, Show } from "solid-js"
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
  useSpinnerClock,
} from "./ui"
import { CommandPalette, CommandProvider, useCommand } from "./commands"
import {
  AUTO_ROW_ID,
  BranchPicker,
  DEFAULT_ROW_ID,
  MessagePicker,
  modelRows,
  PromptSearchPalette,
  reasoningRows,
  SettingsPicker,
} from "./pickers"
import { projectRoot } from "./workspace"
import {
  type StatusRowLabel,
  buildContextLabels,
  buildModelLabels,
  createSessionController,
  formatCwd,
  overlayHoldsComposer,
  SessionControllerContext,
  shortModelName,
  useExit,
} from "./session"
import { ExtensionRenderBoundary, useExtensionUI } from "./extensions/host"
import type { ResolvedWidget } from "./extensions/loader-boundary"
import { Auth, providerLabel } from "./auth"
import {
  type MessageRendererEntry,
  STATUS_YIELD,
  type StatusLabelAnchor,
  type StatusLabelColor,
  type WidgetSlot,
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
  modelId?: ModelId
}): Effect.Effect<DomainSession, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const requestId = yield* randomId
    const result = yield* input.client.session.create({
      cwd: input.cwd,
      requestId,
      ...Record.filter(
        { admission: input.admission, modelId: input.modelId },
        Predicate.isNotUndefined,
      ),
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
  /** The new headless session's own model (`--model`). */
  modelId?: ModelId
}): Effect.Effect<HeadlessState, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const { client, cwd, session, promptArg, admission, modelId } = input
    if (Option.isNone(promptArg) || promptArg.value.trim().length === 0) {
      return yield* new AppBootstrapError({ reason: "headless-missing-prompt" })
    }
    if (Option.isSome(session)) {
      return { session: yield* loadSession(client, session.value), prompt: promptArg.value }
    }
    return {
      session: yield* createAndLoadSession({
        client,
        cwd,
        ...Record.filter({ admission, modelId }, Predicate.isNotUndefined),
      }),
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
 *
 * It is a node on the `ctrl+o` ladder: collapsed is one line that counts the
 * issues, with a tree row for each failed extension (a failure shows at every
 * level) and the key that lists the rest; preview and full list each issue on
 * its own tree row. It draws in the live tail, so a level change costs no
 * history replay.
 */

/** A failed new version whose last good one still runs says which one. */
// eslint-disable-next-line effect/noNullish -- an optional wire field.
const stillRuns = (runningVersion: string | undefined): string =>
  Option.match(Option.fromUndefinedOr(runningVersion), {
    onNone: () => "",
    onSome: (version) => `; version ${version.slice(0, 12)} still runs`,
  })

export function ConnectionWidget(props: { readonly disclosure: DisclosureLevel }) {
  const client = useClient()
  const ext = useExtensionUI()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
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
        .map(
          (issue) => `${extension.manifest.id}: ${issue.error}${stillRuns(issue.runningVersion)}`,
        ),
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
  // What went wrong, counted: the connection issue in its own words, then how
  // many extensions failed and how many model catalogs did not load.
  const summary = () => {
    const parts = Option.toArray(connectionIssue())
    if (hasFailedExtensions())
      parts.push(`${plural(failedExtensions().length, "extension")} failed`)
    if (hasUnavailableCatalogs())
      parts.push(`${plural(unavailableCatalogs().length, "model catalog")} unavailable`)
    return parts.join(" · ")
  }
  // One row per failed extension and per catalog, in that order; collapsed
  // keeps the failures and counts the catalogs on the head line.
  const collapsed = () => props.disclosure === "collapsed"
  const rows = () => {
    if (collapsed()) return failedExtensions()
    return [...failedExtensions(), ...unavailableCatalogs()]
  }
  const hint = () => {
    if (collapsed() && hasUnavailableCatalogs()) return " · ctrl+o"
    return ""
  }
  // The columns right of the indent, less the last column every row keeps free.
  const width = () => dimensions().width - 2 - 1
  const heading = "• connection"
  const connector = (index: number) => {
    if (index === rows().length - 1) return "└"
    return "├"
  }
  return (
    <Show when={visible()}>
      <box flexDirection="column" paddingLeft={2} marginTop={1} marginBottom={1}>
        <text wrapMode="none">
          <span style={{ fg: accent(), bold: true }}>{heading}</span>
          <span style={{ fg: theme.textMuted }}>
            {" "}
            · {truncate(summary(), width() - heading.length - 3 - hint().length)}
            {hint()}
          </span>
        </text>
        <For each={rows()}>
          {(row, index) => (
            <text wrapMode="none" style={{ fg: theme.textMuted }}>
              {connector(index())} {truncate(row, width() - 2)}
            </text>
          )}
        </For>
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

/** Waiting rows past this many fold into one `┊ +N more` row. */
const QUEUE_ROWS = 3

/** The reader's lane for a message not yet delivered: col 0, dashed. */
const WAITING_RAIL = "┊"

/**
 * One waiting row: `┊ <when> · <first line>`, its type's `queueLabel` in
 * place of the text when it has one (a background answer as `↳ answer ·
 * <question>`). The text cuts to `width` columns and keeps ` +N lines` for
 * the lines it leaves out.
 */
const queueRow = (
  entry: QueueEntryInfo,
  when: "next step" | "next turn",
  renderers: ReadonlyMap<string, MessageRendererEntry>,
  width: number,
): string => {
  const head = `${WAITING_RAIL} ${when} · `
  const metadata = Option.fromUndefinedOr(entry.metadata)
  const label = metadata.pipe(
    Option.flatMap((value) => Option.fromUndefinedOr(value.customType)),
    Option.flatMap((type) => Option.fromUndefinedOr(renderers.get(type))),
    Option.flatMap((renderer) => Option.fromUndefinedOr(renderer.queueLabel)),
    Option.map((queueLabel) =>
      queueLabel({
        content: entry.content,
        details: Option.getOrUndefined(Option.map(metadata, (value) => value.details)),
      }),
    ),
  )
  if (Option.isSome(label)) return truncate(head + label.value, width)
  const [first = "", ...rest] = entry.content.split("\n")
  let more = ""
  if (rest.length > 0) more = ` +${plural(rest.length, "line")}`
  const room = Math.max(1, width - textWidth(head) - textWidth(more))
  return truncate(head + truncate(first, room), width - textWidth(more)) + more
}

/** The reader's own message: the server's client origin, never its text. */
const fromReader = (entry: QueueEntryInfo): boolean => entry.metadata?.fromClient === true

/**
 * The reader's waiting entries, pinned between the live line and the
 * composer, in the reader's lane: one dim row each (`next step` for a steer,
 * which the model reads at its next step; `next turn` for a follow-up), at
 * most three, then `┊ +N more`, then the way back to the draft. Not a
 * transcript row: an entry leaves here when it is delivered, and the
 * transcript shows it where it lands. A message another agent or an
 * extension queued (a child's `Session.send`, a wake) draws nowhere until it
 * is delivered. A docked pane takes the rows, as it takes the trays'.
 */
export function QueueWidget(props: QueueWidgetProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const paneOpen = useDockPaneOpen()
  const spacer = useDockSpacer()
  // Every column but the last, which each row keeps free.
  const width = () => Math.max(1, dimensions().width - 1)
  const entries = () => [
    ...props.steerMessages
      .filter(fromReader)
      .map((entry) => ({ entry, when: "next step" as const })),
    ...props.queuedMessages
      .filter(fromReader)
      .map((entry) => ({ entry, when: "next turn" as const })),
  ]
  const rows = () => {
    const all = entries()
    const shown = all
      .slice(0, QUEUE_ROWS)
      .map(({ entry, when }) => queueRow(entry, when, props.messageRenderers, width()))
    if (all.length <= QUEUE_ROWS) return shown
    return [...shown, `${WAITING_RAIL} +${all.length - QUEUE_ROWS} more`]
  }
  return (
    <Show when={entries().length > 0 && !paneOpen()}>
      <box flexDirection="column" flexShrink={0} marginTop={spacer()}>
        <For each={rows()}>
          {(row) => (
            <text wrapMode="none" style={{ fg: theme.textMuted }}>
              {row}
            </text>
          )}
        </For>
        <text wrapMode="none" style={{ fg: theme.textMuted }}>
          {"  "}
          {keyHintsLine([KeyHints.restoreQueue], width() - 2)}
        </text>
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
  // Keyed on the component, not the resolved entry each load makes anew: an
  // extension a client reload kept hands back the same component, so its
  // widget stays mounted with its state. A new version's component mounts.
  const extensionOf = (component: ResolvedWidget["component"]) =>
    Option.fromUndefinedOr(slotWidgets().find((widget) => widget.component === component))

  return (
    <For each={slotWidgets().map((widget) => widget.component)}>
      {(Widget) => (
        <Show when={Option.getOrUndefined(extensionOf(Widget))}>
          {(widget) => (
            <ExtensionRenderBoundary extensionId={widget().extensionId}>
              <Widget />
            </ExtensionRenderBoundary>
          )}
        </Show>
      )}
    </For>
  )
}

/**
 * The live line: `✻ <phase> (<turn elapsed>) · esc cancel`, its glyph
 * pulsing on the spinner clock. Its blank row above gives way while a docked
 * pane is short.
 */
function ActivityRow(props: { label: string; elapsed: number }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const spacer = useDockSpacer()
  const tick = useSpinnerClock()
  // Bright, then muted, every half second: the shape stays, so a monochrome theme reads it.
  const glyphColor = () => {
    if (Math.floor(tick() / 8) % 2 === 0) return theme.text
    return theme.textMuted
  }
  // Under a second the count says nothing.
  const elapsed = () => {
    if (props.elapsed < 1000) return ""
    return ` (${formatDuration(props.elapsed, "compact")})`
  }
  return (
    <box height={1} flexShrink={0} paddingLeft={2} marginTop={spacer()} overflow="hidden">
      <text wrapMode="none" style={{ fg: theme.textMuted }}>
        <span style={{ fg: glyphColor() }}>✻</span>{" "}
        {activityLine(props.label, elapsed(), Math.max(1, dimensions().width - 4))}
      </text>
    </box>
  )
}

/** The status row's model label for a session nobody named a model for. */
export const NO_MODEL_LABEL = "no model · /model"

/**
 * The model as the status row names it: its name, and its provider's label
 * (`providerLabel`) when another provider's model has the same name, so the
 * row says which provider runs, and bills, the next turn. A narrow row takes
 * the label's short form instead (`shortModelName`, no provider label), so
 * the pair `Auto → Sonnet 5` fits beside the effort and the gauge.
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

/** A reasoning row id; `default` decodes to `None` and clears the override, `auto` routes each turn. */
const parseReasoningRow = Schema.decodeUnknownOption(EffortSetting)

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const command = useCommand()
  const dimensions = useTerminalDimensions()
  const controller = createSessionController(props)
  const client = useClient()
  const runtime = useRuntime()
  const ext = useExtensionUI()

  // The project that holds the session's directory, by a stat walk for
  // `.git`; it names the cwd label `repo/sub`. Keyed by the cwd it was found
  // for, so a session move never shows the last session's root, and a walk
  // still out when the cwd moves is interrupted.
  const [root, setRoot] = createSignal(
    Option.none<{ readonly cwd: string; readonly root: Option.Option<string> }>(),
  )
  createEffect(
    on(
      () => client.pathPlace().cwd,
      (cwd) =>
        runtime.call(
          projectRoot(cwd).pipe(
            Effect.tap((found) => Effect.sync(() => setRoot(Option.some({ cwd, root: found })))),
          ),
        ),
    ),
  )
  const rootOf = (cwd: string): Option.Option<string> =>
    root().pipe(
      Option.filter((known) => known.cwd === cwd),
      Option.flatMap((known) => known.root),
    )

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

  /** The extension status labels of one group, by priority, each with its short form. */
  const extensionLabels = (anchor: StatusLabelAnchor): StatusRowLabel[] =>
    ext
      .statusLabelItems(anchor)
      .map((item) => ({ text: item.text, color: resolveColor(item.color), short: item.short }))

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
    const routed = client.routedModel()
    const items: StatusRowLabel[] = []
    const name = (entry: Model) =>
      statusModelName(entry, client.models(), controller.authProviders())
    // The selected model, and the model its newest route chose.
    const named = (format: (entry: Model) => string) =>
      Option.map(model, (selected) =>
        Option.match(routed, {
          onNone: () => format(selected),
          onSome: (route) => `${format(selected)} → ${format(route.model)}`,
        }),
      )
    const full = named(name)
    const short = named((entry) => shortModelName(entry.name))
    if (Option.isSome(full))
      items.push({
        text: full.value,
        color: theme.textMuted,
        short: { text: Option.getOrElse(short, () => full.value), rank: STATUS_YIELD.model },
      })
    // Gent ships no default model: once the snapshot names the agent, a
    // session nobody named a model for says so, and where to name one.
    if (Option.isSome(client.agent()) && Option.isNone(client.model()))
      items.push({ text: NO_MODEL_LABEL, color: theme.warning })
    return items.concat(
      buildModelLabels({
        // The level the turn asks for, after the clamp of the model that runs
        // the turn: the level the step's receipt records. While a turn runs,
        // its own level; a level set meanwhile shows once it completes.
        reasoningLevel: client.turnReasoningLevel(),
        model: client.turnModel(),
        theme,
        debugMode: props.debugMode === true,
        auto: client.reasoningAuto(),
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
        // A virtual model has no window: the gauge reads the routed model's.
        model: client.turnModel(),
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
      // The phase word says least of the row: a narrow row leaves it out
      // last. A cue, an error and a notice never give way.
      items.push({
        text: controller.phaseLabel(),
        color: theme.textMuted,
        short: { text: "", rank: STATUS_YIELD.phase },
      })
    }

    // Where the session is rooted, beside the phase word rather than behind a
    // debug flag. A reader running several sessions at once cannot tell them
    // apart from the model and cost alone, and the cwd is the thing that
    // distinguishes them.
    // The branch and the changes are the `@gent/git` extension's labels. A
    // narrow row leaves the cwd out before it shortens the model.
    const sessionCwd = client.pathPlace().cwd
    items.push({
      text: formatCwd(sessionCwd, rootOf(sessionCwd)),
      color: theme.textMuted,
      short: { text: "", rank: STATUS_YIELD.cwd },
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
          <ConnectionWidget disclosure={controller.uiState().disclosure} />
          <ExtensionWidgets slot="below-messages" />
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
            <ActivityRow label={controller.phaseLabel()} elapsed={controller.elapsed()} />
          </Show>

          {/* The waiting entries sit between the activity row and the
            composer, the controller's queue their one owner. Hardwired: the
            extension context does not expose the queue. */}
          <QueueWidget
            queuedMessages={controller.queueState().followUp}
            steerMessages={controller.queueState().steering}
            messageRenderers={ext.messageRenderers()}
          />

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
            current={client.model()}
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
            title="Effort"
            rows={reasoningRows(
              client.turnModel(),
              client.defaultReasoningLevel(),
              Option.flatMap(client.routedModel(), (route) => route.effort),
              client.effortFallback(),
            )}
            current={Option.some(
              Option.getOrElse(
                Option.orElse(
                  Option.liftPredicate(AUTO_ROW_ID, () => client.reasoningAuto()),
                  () => Option.fromUndefinedOr(client.session().reasoningLevel),
                ),
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
