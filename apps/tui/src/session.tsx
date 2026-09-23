import {
  type Accessor,
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type ParentProps,
} from "solid-js"
import {
  type Array as Arr,
  Clock,
  DateTime,
  Effect,
  Equal,
  Fiber,
  FileSystem,
  Match,
  Option,
  Path,
  Predicate,
  Random,
  Schedule,
  Schema,
  Stream,
} from "effect"
import {
  type ActiveInteraction,
  type AgentEvent,
  type ApprovalResult,
  assistantMessageIdForTurn,
  Branch,
  type BranchId,
  Message as DurableMessage,
  type EventEnvelope,
  InteractionPresented,
  type MessageId,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
  Model,
  type ModelContextMetrics,
  type ModelId,
  projectMessage,
  ReasoningEffort,
  type SessionId,
} from "@gent/core/protocol"
import {
  formatConnectionIssue,
  formatError,
  formatTokens,
  formatToolInput,
  randomId,
  useRequiredContext,
} from "./utils"
import type { RGBA } from "@opentui/core"
import {
  type ClientContextValue,
  type ClientLog,
  type SessionMetrics,
  shutdownLog,
  SteerCommandInput,
  useClient,
  useRuntime,
} from "./client"
import type { AutocompleteContribution, AutocompleteItem } from "./extensions/client-facets.js"
import {
  PromptSearchEvent,
  PromptSearchEvent as PromptSearchEventSchema,
  PromptSearchState,
  PromptSearchState as PromptSearchStateFactory,
  transitionPromptSearch,
} from "./pickers"
import {
  type MessageSegment,
  type ProjectedMessage,
  type QueueEntryInfo,
  type QueueSnapshot,
  type ToolInteraction,
} from "@gent/sdk"
import { useEnv, useWorkspace } from "./workspace"
import {
  clearFrecencyStore,
  frecencyLookup,
  type FrecencyLookup,
  frecencySnapshot,
  noFrecency,
  rankAutocompleteItems,
  readFrecencyStore,
  recordFrecencyPick,
  setFrecencySnapshot,
} from "./autocomplete"
import { type Command, executeSlashCommand, useCommand } from "./commands"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import {
  addStep,
  type AssistantSegment,
  emptyTurnSteps,
  type Message,
  type SessionEvent,
  type SessionItem,
} from "./message-list"
import type { ToolCall } from "./tool-renderers"
import { useRenderer } from "@opentui/solid"
import { type ScopedKeyboardEvent, useScopedKeyboard } from "./terminal"
import { useExtensionUI } from "./extensions/host"

// ── session shell ───────────────────────────────────────────────────────────

/**
 * Session shell — what the TUI carries into the session it booted with.
 *
 * Which session and branch show belongs to `ClientProvider`, where
 * `switchSession` writes it and `session()` reads it. The shell carries the
 * startup prompt.
 *
 * The prompt belongs to the session the startup flags named, on whichever
 * branch of it the reader ends up: picking a branch in the boot picker
 * re-mounts the session view, and the prompt has to survive that. A session
 * the reader opens afterwards is a different session and starts empty, so the
 * shell keys the prompt on the boot session's id rather than handing it to
 * whoever asks first.
 *
 * @module
 */

/** One startup prompt, held by one send at a time. */
interface StartupPrompt {
  readonly content: string
  /** The id of a send that failed. The next send uses it, so the prompt cannot run twice. */
  readonly requestId: Option.Option<string>
  /** Report the send's end. A failed send gives the prompt back to the shell. */
  readonly settle: (sent: boolean, requestId: string) => void
}

interface SessionShellValue {
  /**
   * The `-p` prompt, if this is the session the startup flags named and no
   * send holds it. A session view that mounts again gets nothing while a send
   * is in flight or after one landed.
   */
  readonly takePrompt: (sessionId: SessionId) => Option.Option<StartupPrompt>
}

const SessionShellContext = createContext<SessionShellValue>()

interface SessionShellProviderProps {
  readonly initialPrompt: Option.Option<string>
  /** The session the startup flags resolved to, if there was one. */
  readonly initialSessionId: Option.Option<SessionId>
}

export function SessionShellProvider(props: ParentProps<SessionShellProviderProps>) {
  let failedRequestId = Option.none<string>()
  let held = false
  const value: SessionShellValue = {
    takePrompt: (sessionId) => {
      const owns = Option.exists(props.initialSessionId, (boot) => boot === sessionId)
      if (!owns || held) return Option.none()
      return Option.map(props.initialPrompt, (content) => {
        held = true
        return {
          content,
          requestId: failedRequestId,
          settle: (sent, requestId) => {
            held = sent
            failedRequestId = Option.some(requestId)
          },
        }
      })
    },
  }

  return <SessionShellContext.Provider value={value}>{props.children}</SessionShellContext.Provider>
}

function useSessionShell(): SessionShellValue {
  return useRequiredContext(
    SessionShellContext,
    "useSessionShell must be used within SessionShellProvider",
  )
}

// ── session labels ──────────────────────────────────────────────────────────

/** One colored label on the composer's status row, its color resolved. */
export interface StatusRowLabel {
  text: string
  color: RGBA
}

interface ThemeColors {
  textMuted: RGBA
  error: RGBA
  warning: RGBA
  info: RGBA
}

const pressureColor = (pct: number, theme: ThemeColors): RGBA => {
  if (pct >= 90) return theme.error
  if (pct >= 70) return theme.warning
  return theme.textMuted
}

/** `ctx 42%`: percent of the model's input budget. What the projection dropped is in the thread pane. */
const projectionLabel = (context: ModelContextMetrics, theme: ThemeColors): StatusRowLabel => {
  const pct = Math.min(
    100,
    Math.round((context.estimatedTokens / context.contextLimitTokens) * 100),
  )
  return { text: `ctx ${pct}%`, color: pressureColor(pct, theme) }
}

/**
 * The context gauge alone, for the labels anchored to the right edge.
 *
 * It is split from {@link buildModelLabels} because the two halves sit at
 * opposite ends of the row: effort belongs beside the model name, while the
 * gauge belongs with the running total a reader checks at a glance.
 */
export function buildContextLabels(input: {
  readonly metrics: SessionMetrics
  // eslint-disable-next-line effect/noNullish -- this mirrors the optional client snapshot field.
  readonly contextLength: number | undefined
  readonly theme: ThemeColors
}): StatusRowLabel[] {
  const projection = input.metrics.context
  if (Option.isSome(projection) && projection.value.contextLimitTokens > 0) {
    // The projection is what the model saw; it beats the provider's last usage report.
    return [projectionLabel(projection.value, input.theme)]
  }
  const tokens = input.metrics.latestInputTokens
  const limit = Option.fromNullishOr(input.contextLength)
  if (tokens > 0 && Option.isSome(limit) && limit.value > 0) {
    const pct = Math.min(100, Math.round((tokens / limit.value) * 100))
    return [{ text: `${formatTokens(tokens)} (${pct}%)`, color: pressureColor(pct, input.theme) }]
  }
  return []
}

/**
 * The labels that sit beside the model name: its effort, and the debug mark.
 *
 * The context gauge used to be here too. It moved to {@link buildContextLabels}
 * when the row grew a right-anchored group — effort names how the model is
 * configured, the gauge reports what the session has spent, and the two
 * belong at opposite ends.
 */
export function buildModelLabels(input: {
  readonly reasoningLevel: Option.Option<string>
  readonly theme: ThemeColors
  readonly debugMode: boolean
}): StatusRowLabel[] {
  const items: StatusRowLabel[] = []

  if (Option.isSome(input.reasoningLevel)) {
    items.push({ text: input.reasoningLevel.value, color: input.theme.info })
  }

  if (input.debugMode) {
    items.push({ text: "debug", color: input.theme.warning })
  }

  return items
}

/** `repo/sub/dir (branch)`: the cwd relative to the git root, else its last segment. */
export function formatCwdGit(
  cwd: string,
  gitRoot: Option.Option<string>,
  branch: Option.Option<string>,
): string {
  let label: string
  if (Option.isSome(gitRoot)) {
    const repoParts = gitRoot.value.split("/")
    const repoName = Option.getOrElse(
      Option.fromNullishOr(repoParts[repoParts.length - 1]),
      () => "",
    )
    if (cwd === gitRoot.value) {
      label = repoName
    } else if (cwd.startsWith(gitRoot.value + "/")) {
      label = repoName + "/" + cwd.slice(gitRoot.value.length + 1)
    } else {
      label = Option.getOrElse(Option.fromNullishOr(repoParts[repoParts.length - 1]), () => cwd)
    }
  } else {
    const parts = cwd.split("/")
    label = Option.getOrElse(Option.fromNullishOr(parts[parts.length - 1]), () => cwd)
  }

  if (Option.isSome(branch) && branch.value.length > 0) {
    return `${label} (${branch.value})`
  }
  return label
}

// ── model query ─────────────────────────────────────────────────────────────

/**
 * Resolving a typed model query against the registry catalogue.
 *
 * Shared by `/model <query>` and the model picker's filter row so the two
 * agree on what a query matches: the exact id first, then a case-insensitive
 * substring of the id or display name.
 *
 * @module
 */

const normalize = (query: string): string => query.trim().toLowerCase()

export const filterModels = (models: readonly Model[], query: string): readonly Model[] => {
  const needle = normalize(query)
  if (needle.length === 0) return models
  return models.filter(
    (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
  )
}

const ModelQueryResult = Schema.TaggedUnion({
  Match: { model: Model },
  None: {},
  Ambiguous: { candidates: Schema.Array(Model) },
})
type ModelQueryResult = Schema.Schema.Type<typeof ModelQueryResult>

export const resolveModelQuery = (models: readonly Model[], query: string): ModelQueryResult => {
  const needle = normalize(query)
  const exact = Option.fromNullishOr(models.find((model) => model.id.toLowerCase() === needle))
  if (Option.isSome(exact)) return ModelQueryResult.cases.Match.make({ model: exact.value })
  const candidates = filterModels(models, needle)
  const single = Option.fromNullishOr(candidates[0])
  if (candidates.length === 1 && Option.isSome(single)) {
    return ModelQueryResult.cases.Match.make({ model: single.value })
  }
  if (candidates.length === 0) return ModelQueryResult.cases.None.make({})
  return ModelQueryResult.cases.Ambiguous.make({ candidates })
}

// ── composer interaction state ──────────────────────────────────────────────

export interface AutocompleteState {
  type: string
  filter: string
  triggerPos: number
}

export interface ComposerInteractionState {
  readonly draft: string
  readonly mode: "editing" | "shell"
  readonly autocomplete: Option.Option<AutocompleteState>
}

export const ComposerInteractionState = {
  initial: (): ComposerInteractionState => ({
    draft: "",
    mode: "editing",
    autocomplete: Option.none(),
  }),
}

export const ComposerInteractionEvent = Schema.TaggedUnion({
  DraftChanged: { text: Schema.String },
  RestoreDraft: { text: Schema.String },
  ClearDraft: {},
  EnterShell: {},
  ExitShell: {},
  CloseAutocomplete: {},
})
export type ComposerInteractionEvent = Schema.Schema.Type<typeof ComposerInteractionEvent>

/**
 * Derive autocomplete state from text and registered contributions.
 * Inline triggers (like $ and @) detected anywhere after whitespace.
 * Start triggers (like /) detected only at text position 0.
 */
const deriveAutocomplete = (
  _state: ComposerInteractionState,
  text: string,
  contributions: ReadonlyArray<AutocompleteContribution>,
): Option.Option<AutocompleteState> => {
  if (_state.mode === "shell") return Option.none()

  const prefixes = contributions.map((c) => c.prefix)
  if (prefixes.length === 0) return Option.none()

  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const regex = new RegExp(`(?:^|[\\s])([${escaped.join("")}])([^\\s]*)$`)
  return Option.fromNullishOr(regex.exec(text)).pipe(
    Option.flatMap((match) =>
      Option.all([
        Option.fromNullishOr(match[0]),
        Option.fromNullishOr(match[1]),
        Option.fromNullishOr(match[2]),
      ]),
    ),
    Option.flatMap(([fullMatch, prefix, filter]) => {
      if (prefix.length === 0) return Option.none()
      let leadingWhitespaceLength = 0
      if (fullMatch.startsWith(" ")) leadingWhitespaceLength = 1
      const triggerPos = text.length - fullMatch.length + leadingWhitespaceLength

      if (prefix === "/" && triggerPos !== 0) return Option.none()
      return Option.some({ type: prefix, filter, triggerPos })
    }),
  )
}

export function transitionComposerInteraction(
  state: ComposerInteractionState,
  event: ComposerInteractionEvent,
  contributions: ReadonlyArray<AutocompleteContribution> = [],
): ComposerInteractionState {
  if (event._tag === "DraftChanged") {
    return {
      ...state,
      draft: event.text,
      autocomplete: deriveAutocomplete(state, event.text, contributions),
    }
  }

  if (event._tag === "RestoreDraft") {
    return { ...state, draft: event.text, autocomplete: Option.none() }
  }

  if (event._tag === "ClearDraft") {
    return { ...state, draft: "", autocomplete: Option.none() }
  }

  if (event._tag === "EnterShell") {
    return { ...state, mode: "shell", autocomplete: Option.none() }
  }

  if (event._tag === "ExitShell") {
    return { ...state, mode: "editing", autocomplete: Option.none() }
  }

  return { ...state, autocomplete: Option.none() }
}

// ── composer state ──────────────────────────────────────────────────────────

/**
 * Composer state — raw interaction events, no normalization.
 *
 * Shell mode, autocomplete, and history are local controller concerns.
 * This state handles server-driven interaction flows (questions, permissions, prompts, handoffs).
 */

const ApprovalResultSchema = Schema.Struct({
  approved: Schema.Boolean,
  notes: Schema.optional(Schema.String),
  editedContent: Schema.optional(Schema.String),
})

export type ComposerState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "interaction"; readonly interaction: ActiveInteraction }

export const ComposerState = {
  idle: (): ComposerState => ({ _tag: "idle" }),
}

export const ComposerEvent = Schema.TaggedUnion({
  EnterInteraction: { interaction: InteractionPresented },
  ResolveInteraction: { result: ApprovalResultSchema },
  DismissInteraction: { requestId: Schema.String },
})
export type ComposerEvent = Schema.Schema.Type<typeof ComposerEvent>

type ComposerEffect = {
  readonly _tag: "DispatchInteractionResult"
  readonly interaction: ActiveInteraction
  readonly result: ApprovalResult
}

interface TransitionResult {
  readonly state: ComposerState
  readonly effect?: ComposerEffect
}

export function transition(state: ComposerState, event: ComposerEvent): TransitionResult {
  if (event._tag === "EnterInteraction") {
    return { state: { _tag: "interaction", interaction: event.interaction } }
  }

  if (event._tag === "ResolveInteraction") {
    if (state._tag !== "interaction") return { state }
    return {
      state: ComposerState.idle(),
      effect: {
        _tag: "DispatchInteractionResult",
        interaction: state.interaction,
        result: event.result,
      },
    }
  }

  if (state._tag !== "interaction") return { state }
  if (!("requestId" in state.interaction) || state.interaction.requestId !== event.requestId) {
    return { state }
  }
  return { state: ComposerState.idle() }
}

// ── composer drafts ─────────────────────────────────────────────────────────

type ComposerDraft = Pick<ComposerInteractionState, "draft" | "mode">

interface ComposerDrafts {
  readonly get: (branchId: BranchId) => Option.Option<ComposerDraft>
  readonly set: (branchId: BranchId, draft: ComposerDraft) => void
}

const ComposerDraftsContext = createContext<ComposerDrafts>()

export function ComposerDraftsProvider(props: ParentProps) {
  const drafts = new Map<BranchId, ComposerDraft>()
  const value: ComposerDrafts = {
    get: (branchId) => Option.fromNullishOr(drafts.get(branchId)),
    set: (branchId, draft) => {
      if (draft.draft.length === 0 && draft.mode === "editing") {
        drafts.delete(branchId)
        return
      }
      drafts.set(branchId, draft)
    },
  }
  return (
    <ComposerDraftsContext.Provider value={value}>{props.children}</ComposerDraftsContext.Provider>
  )
}

const useComposerDrafts = () =>
  useRequiredContext(ComposerDraftsContext, "Composer drafts require ComposerDraftsProvider")

// ── session UI state ────────────────────────────────────────────────────────

/** The palette owns its own state; the overlay carries it rather than copying its fields. */
interface PromptSearchOverlayState {
  readonly _tag: "prompt-search"
  readonly state: PromptSearchState
}

type SessionOverlayState =
  | { readonly _tag: "none" }
  | { readonly _tag: "fork"; readonly messages: readonly DurableMessage[] }
  | { readonly _tag: "mermaid" }
  | { readonly _tag: "auth"; readonly enforceAuth: boolean }
  | { readonly _tag: "model" }
  | { readonly _tag: "reasoning" }
  /**
   * The branch picker. The boot flow is the only thing that opens it, so
   * escape quits: a reader who never chose a branch has nowhere to fall back
   * to, which is what the old boot route did too.
   */
  | { readonly _tag: "branches"; readonly branches: readonly Branch[] }
  | PromptSearchOverlayState
  /**
   * A client extension's docked pane, by the name the extension gave it. It
   * shares this union so one pane or picker is open at a time; unlike the
   * session's own overlays it leaves the composer focused and its keys live.
   */
  | { readonly _tag: "pane"; readonly id: string }

/** Whether the overlay takes the composer and the session's keys; an extension pane does not. */
export const overlayHoldsComposer = (overlay: SessionOverlayState): boolean =>
  overlay._tag !== "none" && overlay._tag !== "pane"

/** How much of each tool group the inline transcript shows. `ctrl+o` cycles; `esc` collapses. */
export type DisclosureLevel = "collapsed" | "preview" | "full"

const DISCLOSURE_CYCLE: readonly DisclosureLevel[] = ["collapsed", "preview", "full"]

export const nextDisclosure = (level: DisclosureLevel): DisclosureLevel =>
  DISCLOSURE_CYCLE[(DISCLOSURE_CYCLE.indexOf(level) + 1) % DISCLOSURE_CYCLE.length] ?? "collapsed"

export interface SessionUiState {
  readonly disclosure: DisclosureLevel
  readonly transcriptExpanded: boolean
  readonly displayRevision: number
  readonly overlay: SessionOverlayState
}

export const SessionUiState = {
  /**
   * `initialBranches` opens the branch picker before the first render, because
   * the picker is also what holds the auth gate and the startup prompt. Opening
   * it later would let both act on a branch the reader has not picked yet.
   */
  initial: (initialBranches: Option.Option<readonly Branch[]> = Option.none()): SessionUiState => ({
    disclosure: "collapsed",
    transcriptExpanded: false,
    displayRevision: 0,
    overlay: Option.match(initialBranches, {
      onNone: (): SessionOverlayState => ({ _tag: "none" }),
      onSome: (branches): SessionOverlayState => ({ _tag: "branches", branches }),
    }),
  }),
}

const SessionUiEvent = Schema.TaggedUnion({
  CycleDisclosure: {},
  CollapseDisclosure: {},
  ToggleTranscript: {},
  ClearDisplay: {},
  OpenFork: { messages: Schema.Array(DurableMessage) },
  OpenMermaid: {},
  OpenAuth: { enforceAuth: Schema.Boolean },
  OpenSettingsPicker: { picker: Schema.Literals(["model", "reasoning"]) },
  OpenBranches: { branches: Schema.Array(Branch) },
  OpenPane: { id: Schema.String },
  /** Closes the named pane only, so a late close never shuts the pane that replaced it. */
  ClosePane: { id: Schema.String },
  CloseOverlay: {},
  PromptSearch: { event: PromptSearchEventSchema },
})
type SessionUiEvent = Schema.Schema.Type<typeof SessionUiEvent>

type SessionUiEffect = { readonly _tag: "RestoreComposer"; readonly text: string }

interface SessionUiTransitionResult {
  readonly state: SessionUiState
  readonly effects: readonly SessionUiEffect[]
}

export function transitionSessionUi(
  state: SessionUiState,
  event: SessionUiEvent,
): SessionUiTransitionResult {
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      ClearDisplay: (): SessionUiTransitionResult => ({
        state: { ...state, displayRevision: state.displayRevision + 1, transcriptExpanded: false },
        effects: [],
      }),
      ToggleTranscript: (): SessionUiTransitionResult => ({
        state: { ...state, transcriptExpanded: !state.transcriptExpanded },
        effects: [],
      }),
      CycleDisclosure: (): SessionUiTransitionResult => ({
        state: { ...state, disclosure: nextDisclosure(state.disclosure) },
        effects: [],
      }),
      CollapseDisclosure: (): SessionUiTransitionResult => ({
        state: { ...state, disclosure: "collapsed" },
        effects: [],
      }),
      OpenFork: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "fork", messages: event.messages },
        },
        effects: [],
      }),
      OpenMermaid: (): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "mermaid" },
        },
        effects: [],
      }),
      OpenAuth: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "auth", enforceAuth: event.enforceAuth },
        },
        effects: [],
      }),
      OpenSettingsPicker: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: event.picker },
        },
        effects: [],
      }),
      OpenBranches: (event): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "branches", branches: event.branches },
        },
        effects: [],
      }),
      OpenPane: (event): SessionUiTransitionResult => ({
        state: { ...state, overlay: { _tag: "pane", id: event.id } },
        effects: [],
      }),
      ClosePane: (event): SessionUiTransitionResult => {
        if (state.overlay._tag !== "pane" || state.overlay.id !== event.id) {
          return { state, effects: [] }
        }
        return { state: { ...state, overlay: { _tag: "none" } }, effects: [] }
      },
      CloseOverlay: (): SessionUiTransitionResult => ({
        state: {
          ...state,
          overlay: { _tag: "none" },
        },
        effects: [],
      }),
      PromptSearch: (event): SessionUiTransitionResult => {
        let promptState = PromptSearchStateFactory.closed()
        if (state.overlay._tag === "prompt-search") promptState = state.overlay.state
        const result = transitionPromptSearch(promptState, event.event)
        // Only a preview reaches the composer; the palette closes through the overlay.
        const effects = result.effects
          .filter((effect) => effect._tag === "Preview")
          .map((effect): SessionUiEffect => ({ _tag: "RestoreComposer", text: effect.text }))
        let nextOverlay: SessionOverlayState = { _tag: "none" }
        if (result.state._tag === "open") {
          nextOverlay = { _tag: "prompt-search", state: result.state }
        }
        return {
          state: {
            ...state,
            overlay: nextOverlay,
          },
          effects,
        }
      },
    }),
  )
}

// ── controller state ────────────────────────────────────────────────────────

type QueueState = {
  steering: readonly QueueEntryInfo[]
  followUp: readonly QueueEntryInfo[]
}

type AuthGateState = "checking" | "open" | "closed" | "error"

interface SessionControllerState {
  readonly authGate: AuthGateState
  readonly validatedAgent?: string
  readonly authCheckVersion: number
  readonly queue: QueueState
  readonly elapsed: number
}

const emptyQueueState = (): QueueState => ({ steering: [], followUp: [] })

export const initialSessionControllerState = (input: {
  readonly debugMode?: boolean
  readonly missingAuthProviders?: readonly string[]
  readonly agent?: string
}): SessionControllerState => {
  const missingProviders = Option.fromNullishOr(input.missingAuthProviders)
  let authGate: AuthGateState = "closed"
  if (
    input.debugMode !== true &&
    Option.isSome(missingProviders) &&
    missingProviders.value.length > 0
  ) {
    authGate = "open"
  }
  const state: SessionControllerState = {
    authGate,
    authCheckVersion: 0,
    queue: emptyQueueState(),
    elapsed: 0,
  }
  const agent = Option.fromNullishOr(input.agent)
  return Option.match(agent, {
    onNone: () => state,
    onSome: (value) => ({ ...state, validatedAgent: value }),
  })
}

export const beginAuthCheck = (state: SessionControllerState): SessionControllerState => ({
  ...state,
  authGate: "checking",
  authCheckVersion: state.authCheckVersion + 1,
})

export const completeAuthCheck = (
  state: SessionControllerState,
  input: {
    readonly version: number
    readonly agent: string
    readonly missing: boolean
  },
): SessionControllerState => {
  if (input.version !== state.authCheckVersion) return state
  let authGate: AuthGateState = "closed"
  if (input.missing) authGate = "open"
  return { ...state, validatedAgent: input.agent, authGate }
}

export const failAuthCheck = (
  state: SessionControllerState,
  version: number,
): SessionControllerState => {
  if (version !== state.authCheckVersion) return state
  return {
    ...state,
    validatedAgent: Option.getOrUndefined(Option.none()),
    authGate: "error",
  }
}

export const closeAuthGateState = (
  state: SessionControllerState,
  // eslint-disable-next-line effect/noNullish -- auth gate closure may omit an agent override.
  agent: string | undefined,
): SessionControllerState => ({
  ...state,
  authCheckVersion: state.authCheckVersion + 1,
  validatedAgent: Option.getOrUndefined(Option.fromNullishOr(agent)),
  authGate: "closed",
})

export const setQueue = (
  state: SessionControllerState,
  queue: QueueState,
): SessionControllerState => ({
  ...state,
  queue,
})

export const clearQueue = (state: SessionControllerState): SessionControllerState =>
  setQueue(state, emptyQueueState())

const setControllerElapsed = (
  state: SessionControllerState,
  elapsed: number,
): SessionControllerState => ({
  ...state,
  elapsed,
})

// eslint-disable-next-line effect/noNullish -- queue projection omits text when the queue is empty.
export const queuedDraftText = (queue: QueueState): string | undefined => {
  const all = [...queue.steering, ...queue.followUp]
  if (all.length === 0) return Option.getOrUndefined(Option.none())
  return all.map((entry) => entry.content).join("\n")
}

const isBlockingAuthGate = (state: AuthGateState): boolean => state === "open" || state === "error"

// eslint-disable-next-line effect/noUnknownParameters -- auth failures cross the Effect and UI boundary.
const formatAuthGateError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (Predicate.isObject(error) && "message" in error) {
    const message = error["message"]
    if (Predicate.isString(message)) return message
  }
  return String(error)
}

// ── controller activity ─────────────────────────────────────────────────────

const THINKING_WORDS = [
  "thinking",
  "pondering",
  "reasoning",
  "analyzing",
  "processing",
  "evaluating",
  "reflecting",
  "deliberating",
  "considering",
  "contemplating",
  "mulling",
  "deducing",
  "inferring",
  "examining",
  "synthesizing",
  "assessing",
  "ruminating",
] satisfies Arr.NonEmptyReadonlyArray<string>

export const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

const pickThinkingWord = (random: number): string => {
  const word = THINKING_WORDS[Math.floor(random * THINKING_WORDS.length)]
  return Option.getOrElse(Option.fromNullishOr(word), () => THINKING_WORDS[0])
}

// ── prompt history ──────────────────────────────────────────────────────────

/**
 * Prompt history — navigate previous prompts with up/down arrows.
 *
 * Plain text entries, persisted to ~/.cache/gent/prompt-history.json.
 * Max 100 entries. Deduplicates against the last entry on add.
 *
 * File access runs on the client runtime, which already carries
 * `FileSystem` and `Path`. The cache paths come from the workspace home the
 * shell mounted with, computed inside the hook rather than at module load.
 */

const MAX_ENTRIES = 100

const HistoryStore = Schema.Struct({ entries: Schema.Array(Schema.String) })
const decodeHistoryStore = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryStore))
const encodeHistoryStore = Schema.encodeSync(Schema.fromJsonString(HistoryStore))

const historyPaths = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.join(home, ".cache", "gent")
    return { directory, file: path.join(directory, "prompt-history.json") }
  })

/** Absent for no file, unreadable content, or bad JSON — history starts fresh. */
export const readEntries = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* historyPaths(home)
    const exists = yield* fs.exists(paths.file)
    if (!exists) return Option.none<ReadonlyArray<string>>()
    const text = yield* fs.readFileString(paths.file)
    if (text.length === 0) return Option.none<ReadonlyArray<string>>()
    return Option.map(decodeHistoryStore(text), (store) => store.entries)
  }).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()))

export const writeEntries = (home: string, items: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* historyPaths(home)
    yield* fs.makeDirectory(paths.directory, { recursive: true })
    yield* fs.writeFileString(paths.file, encodeHistoryStore(HistoryStore.make({ entries: items })))
  }).pipe(Effect.ignoreCause)

export function canNavigateAtCursor(
  direction: "up" | "down",
  cursorPos: number,
  textLength: number,
  inHistory: boolean,
): boolean {
  const pos = Math.max(0, Math.min(cursorPos, textLength))
  if (inHistory) return pos === 0 || pos === textLength
  if (direction === "up") return pos === 0
  return pos === textLength
}

interface NavigateResult {
  readonly handled: boolean
  readonly text?: string
  readonly cursor?: "start" | "end"
}

interface PromptHistory {
  readonly entries: () => readonly string[]
  /** Add a submitted prompt to history. */
  readonly add: (text: string) => void
  /**
   * Navigate history. Pass current input text so it can be saved/restored.
   * Returns `{ handled: true, text, cursor }` if navigation occurred.
   */
  readonly navigate: (
    direction: "up" | "down",
    currentText: string,
    cursorPos: number,
    textLength: number,
  ) => NavigateResult
  /** Reset navigation state (e.g., on submit or mode change). */
  readonly reset: () => void
}

type PromptHistoryStore = {
  entries: ReturnType<typeof createSignal<string[]>>[0]
  setEntries: ReturnType<typeof createSignal<string[]>>[1]
  historyIndex: number
  savedEntry: Option.Option<string>
  loaded: boolean
}

let promptHistorySingleton: Option.Option<PromptHistoryStore> = Option.none()

const getStore = (): PromptHistoryStore => {
  if (Option.isSome(promptHistorySingleton)) return promptHistorySingleton.value

  const [entries, setEntries] = createSignal<string[]>([])
  const store: PromptHistoryStore = {
    entries,
    setEntries,
    historyIndex: -1,
    savedEntry: Option.none(),
    loaded: false,
  }
  promptHistorySingleton = Option.some(store)
  return store
}

export function usePromptHistory(): PromptHistory {
  const store = getStore()
  const workspace = useWorkspace()
  const { cast } = useRuntime()

  const ensureLoaded = () => {
    if (store.loaded) return
    store.loaded = true
    cast(
      readEntries(workspace.home).pipe(
        Effect.tap((loaded) =>
          Effect.sync(() => {
            if (Option.isNone(loaded)) return
            store.setEntries([...loaded.value.slice(0, MAX_ENTRIES)])
          }),
        ),
      ),
    )
  }

  const persist = (items: string[]) => {
    cast(writeEntries(workspace.home, items))
  }

  ensureLoaded()

  return {
    entries: () => store.entries(),

    add(text: string) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return

      store.setEntries((prev) => {
        if (prev[0] === trimmed) return prev
        const next = [trimmed, ...prev].slice(0, MAX_ENTRIES)
        persist(next)
        return next
      })
      store.historyIndex = -1
      store.savedEntry = Option.none()
    },

    navigate(
      direction: "up" | "down",
      currentText: string,
      cursorPos: number,
      textLength: number,
    ): NavigateResult {
      const inHistory = store.historyIndex >= 0
      if (!canNavigateAtCursor(direction, cursorPos, textLength, inHistory)) {
        return { handled: false }
      }

      const list = store.entries()
      if (list.length === 0 && direction === "up") return { handled: false }

      if (direction === "up") {
        if (store.historyIndex === -1) {
          store.savedEntry = Option.some(currentText)
          store.historyIndex = 0
          return { handled: true, text: list[0], cursor: "start" }
        }
        if (store.historyIndex < list.length - 1) {
          store.historyIndex += 1
          return { handled: true, text: list[store.historyIndex], cursor: "start" }
        }
        return { handled: false }
      }

      // down
      if (store.historyIndex > 0) {
        store.historyIndex -= 1
        return { handled: true, text: list[store.historyIndex], cursor: "end" }
      }
      if (store.historyIndex === 0) {
        store.historyIndex = -1
        const restored = Option.getOrElse(store.savedEntry, () => "")
        store.savedEntry = Option.none()
        return { handled: true, text: restored, cursor: "end" }
      }
      return { handled: false }
    },

    reset() {
      store.historyIndex = -1
      store.savedEntry = Option.none()
    },
  }
}

// ── autocomplete frecency hook ──────────────────────────────────────────────

/**
 * The live pick history behind the composer's autocomplete ranking.
 *
 * One store serves every prefix and every session. The value lives in
 * the frecency store in `autocomplete.ts` rather than here, because two surfaces
 * record picks — this hook for `/` commands, and the `$` skills extension —
 * and a cache owned by one of them goes stale the moment the other writes.
 * A snapshot loaded once and written back on every `/` pick would erase
 * whatever `$` wrote in between.
 *
 * So this hook keeps no store of its own. It reads the shared snapshot for
 * ranking and delegates every write to `recordFrecencyPick`, which folds the
 * pick into what is actually on disk under a single-permit gate.
 *
 * Ranking stays synchronous. It runs inside the popup's resource callback,
 * which Solid runs under `untrack`, so nothing read there can make the popup
 * re-rank. The lookup is therefore a plain map read of the shared snapshot,
 * re-done on the next keystroke, which is when a new ranking is wanted anyway.
 * Until the first load lands it answers zero, which is the same thing it
 * answers for a reader with no history: the popup ranks by match quality and
 * nothing waits.
 *
 * Writes never block the keystroke path either. `cast` forks the write onto
 * the client runtime and returns immediately.
 */

interface AutocompleteFrecency {
  /** The reader's decayed pick weights, fixed at the moment of the call. */
  readonly lookup: () => FrecencyLookup
  /** Records that the reader chose `id` from the `prefix` popup. */
  readonly record: (prefix: string, id: string) => void
  /** Forgets every pick, so ranking falls back to match quality alone. */
  readonly reset: () => void
}

/** Whether the store has been read from disk yet, once per process. */
let frecencyLoaded = false

function useAutocompleteFrecency(): AutocompleteFrecency {
  const workspace = useWorkspace()
  const { cast } = useRuntime()

  if (!frecencyLoaded) {
    frecencyLoaded = true
    cast(
      Effect.tap(readFrecencyStore(workspace.home), (snapshot) =>
        Effect.sync(() => {
          if (Option.isNone(snapshot)) return
          setFrecencySnapshot(snapshot.value)
        }),
      ),
    )
  }

  return {
    lookup: () => frecencyLookup(frecencySnapshot(), currentMillis()),
    record: (prefix: string, id: string) => {
      cast(recordFrecencyPick(workspace.home, prefix, id, currentMillis()))
    },
    reset: () => {
      cast(clearFrecencyStore(workspace.home))
    },
  }
}

// ── prompt search controller ────────────────────────────────────────────────

interface PromptSearchController {
  readonly state: () => PromptSearchState
  /** The history the palette searches, newest first. */
  readonly entries: () => readonly string[]
  readonly isOpen: () => boolean
  readonly open: () => void
  readonly onEvent: (event: PromptSearchEvent) => void
}

function createPromptSearchController(params: {
  readonly state: () => PromptSearchState
  readonly entries: () => readonly string[]
  readonly draft: () => string
  readonly dispatch: (event: PromptSearchEvent) => void
}): PromptSearchController {
  return {
    state: params.state,
    entries: params.entries,
    isOpen: () => params.state()._tag === "open",
    open: () => {
      params.dispatch(PromptSearchEvent.cases.Open.make({ draftBeforeOpen: params.draft() }))
    },
    onEvent: params.dispatch,
  }
}

// ── session command registry ────────────────────────────────────────────────

interface SessionCommandRegistryProps {
  readonly client: ClientContextValue
  readonly ext: {
    readonly commands: Accessor<ReadonlyArray<Command>>
    readonly setSessionCommands: (commands: ReadonlyArray<Command>) => void
    readonly setDynamicAutocomplete: (items: ReadonlyArray<AutocompleteContribution>) => void
  }
  readonly cast: <A, E>(effect: Effect.Effect<A, E, never>) => void
  /** The reader's pick history, so a command they choose often ranks first. */
  readonly frecency: () => FrecencyLookup
  /** Records that the reader chose a command from the `/` popup. */
  readonly recordPick: (id: string) => void
  /** Forgets every recorded pick, so ranking starts over. */
  readonly resetFrecency: () => void
  readonly openForkPicker: () => void
  readonly openModelPicker: () => void
  readonly openReasoningPicker: () => void
  readonly openAuth: () => void
}

/** `/think <level>`: a core reasoning level, or `default`/`off` to clear the session override. */
const ReasoningLevelInput = Schema.Union([ReasoningEffort, Schema.Literals(["default", "off"])])
const VALID_REASONING_LEVELS = ["default", ...ReasoningEffort.literals]

const parseReasoningLevel = Schema.decodeUnknownOption(ReasoningLevelInput)

const AMBIGUOUS_PREVIEW = 4

const describeAmbiguous = (query: string, candidates: readonly Model[]): string => {
  const shown: string[] = candidates.slice(0, AMBIGUOUS_PREVIEW).map((model) => model.id)
  if (candidates.length > AMBIGUOUS_PREVIEW) shown.push("…")
  return `"${query}" matches ${candidates.length} models: ${shown.join(", ")}`
}

/**
 * Every command the reader could mean, ranked best first.
 *
 * The filtering used to happen here, by asking whether the slash name or the
 * title contained the filter, and the surviving commands kept their
 * registration order. Both halves were wrong for a popup whose first row is
 * preselected: a title match counted for as much as a name match, so `/ag` led
 * with `/fork` ("Fork from Mess**ag**e"), and nothing afterwards reordered it.
 *
 * Now the list is built unfiltered — names and aliases both — and
 * {@link rankAutocompleteItems} decides what matches and in what order. It
 * scores names far above descriptions, so a command whose description happens
 * to carry the letters still appears, but never ahead of the one actually
 * named.
 *
 * `frecency` carries the reader's own pick history. Without it `/t` answers
 * `think` forever, because `think` and `thread` tie on everything but length;
 * with it, the one this reader actually opens wins. It defaults to "no
 * history", so a caller that has not loaded a store ranks exactly as before.
 */
export const slashAutocompleteItems = (
  commands: readonly Command[],
  filter: string,
  frecency: FrecencyLookup = noFrecency,
): ReadonlyArray<AutocompleteItem> => {
  const items: Array<AutocompleteItem> = []
  for (const command of commands) {
    const slash = Option.fromNullishOr(command.slash)
    if (Option.isNone(slash)) continue
    const description = command.description ?? command.title
    items.push({ id: slash.value, label: `/${slash.value}`, description })
    for (const alias of command.aliases ?? []) {
      items.push({ id: alias, label: `/${alias}`, description })
    }
  }
  return rankAutocompleteItems(items, filter, { prefix: "/", frecency })
}

const createSessionBuiltins = (props: SessionCommandRegistryProps): Command[] => [
  {
    id: "session.new",
    title: "New Session",
    category: "Session",
    slash: "new",
    aliases: ["clear"],
    onSelect: () => props.client.createSession(),
  },
  {
    id: "session.frecency-reset",
    title: "Reset Autocomplete Ranking",
    description: "Forget which commands and skills you pick most (/frecency-reset)",
    category: "Session",
    slash: "frecency-reset",
    onSelect: props.resetFrecency,
  },
  {
    id: "session.branch",
    title: "Create Branch",
    category: "Session",
    slash: "branch",
    onSelect: () => {
      props.cast(props.client.surfaceError(props.client.createBranch()))
    },
  },
  {
    id: "session.fork",
    title: "Fork from Message",
    category: "Session",
    slash: "fork",
    onSelect: props.openForkPicker,
  },
  {
    id: "session.think",
    title: "Set Reasoning Level",
    description: "Pick the reasoning level for this session (/think <level>, /think default)",
    category: "Session",
    slash: "think",
    onSelect: props.openReasoningPicker,
    onSlash: (args) => {
      const level = args.trim().toLowerCase()
      if (level.length === 0) {
        props.openReasoningPicker()
        return
      }
      const reasoningLevel = parseReasoningLevel(level)
      if (Option.isNone(reasoningLevel)) {
        props.client.setError(`Usage: /think <${VALID_REASONING_LEVELS.join("|")}>`)
        return
      }
      // `default`/`off` decode to `None`, which clears the session override.
      const sessionReasoningLevel = Option.getOrUndefined(
        Schema.decodeUnknownOption(ReasoningEffort)(reasoningLevel.value),
      )
      props.cast(
        props.client
          .updateSessionSettings((current) => ({
            ...current,
            reasoningLevel: sessionReasoningLevel,
          }))
          .pipe(props.client.surfaceError),
      )
    },
  },
  {
    id: "session.model",
    title: "Set Model",
    description: "Pick the model for this session (/model <id or name>, /model default)",
    category: "Session",
    slash: "model",
    onSelect: props.openModelPicker,
    onSlash: (args) => {
      const query = args.trim()
      if (query.length === 0) {
        props.openModelPicker()
        return
      }
      const apply = (modelId: Option.Option<ModelId>) =>
        props.cast(
          props.client
            .updateSessionSettings((current) => ({
              ...current,
              modelId: Option.getOrUndefined(modelId),
            }))
            .pipe(props.client.surfaceError),
        )
      if (query === "default" || query === "off") {
        apply(Option.none())
        return
      }
      Match.type<ModelQueryResult>().pipe(
        Match.tagsExhaustive({
          Match: (result) => apply(Option.some(result.model.id)),
          None: () => props.client.setError(`No model matches "${query}"`),
          Ambiguous: (result) => props.client.setError(describeAmbiguous(query, result.candidates)),
        }),
      )(resolveModelQuery(props.client.models(), query))
    },
  },
  {
    id: "session.auth",
    title: "Manage API Keys",
    category: "Session",
    slash: "auth",
    onSelect: props.openAuth,
  },
]

const createSessionCommandRegistry = (props: SessionCommandRegistryProps): void => {
  props.ext.setSessionCommands(createSessionBuiltins(props))

  createEffect(() => {
    const allCommands = props.ext.commands()
    props.ext.setDynamicAutocomplete([
      {
        prefix: "/",
        title: "Commands",
        items: (filter) => slashAutocompleteItems(allCommands, filter, props.frecency()),
        // Without this a slash pick is never recorded, and `/t` answers
        // `think` forever however often the reader opens `/thread`.
        onSelect: (id: string) => props.recordPick(id),
      },
    ])
  })

  onCleanup(() => {
    props.ext.setSessionCommands([])
    props.ext.setDynamicAutocomplete([])
  })
}

// ── session feed ────────────────────────────────────────────────────────────

/**
 * Session feed — keyed projection of server events into UI state.
 *
 * Takes explicit (sessionId, branchId) and subscribes exactly once per identity.
 * No dependency on client.session() or machine state — immune to the
 * UpdateBypass/UpdateSettings re-run footgun.
 */

interface ReconnectOptions<E> {
  readonly label?: string
  readonly log: ClientLog
  readonly onError?: (error: E) => void
  readonly waitForRetry: () => Effect.Effect<void>
}

const reconnectBackoff = Schedule.min([
  Schedule.exponential("1 second", 2),
  Schedule.spaced("30 seconds"),
])

const runWithReconnect = <E, R>(
  effectFactory: () => Effect.Effect<void, E, R>,
  options: ReconnectOptions<E>,
): Effect.Effect<never, never, R> => {
  let attempt = 0
  const label = Option.getOrElse(Option.fromNullishOr(options.label), () => "unknown")
  const log = options.log
  return Effect.gen(function* () {
    attempt++
    log.info("reconnect.attempt", { label, attempt })
    yield* effectFactory().pipe(
      Effect.catchEager((error) =>
        Effect.sync(() => {
          log.warn("reconnect.error", { label, attempt, error: String(error) })
          const onError = Option.fromNullishOr(options.onError)
          if (Option.isSome(onError)) onError.value(error)
        }),
      ),
    )
    log.info("reconnect.stream-ended", { label, attempt })
    log.info("reconnect.wait-for-ready", { label, attempt })
    yield* options.waitForRetry()
    log.info("reconnect.ready", { label, attempt })
  }).pipe(Effect.repeat(reconnectBackoff), Effect.andThen(Effect.never))
}

// ── Types ──

interface SessionFeedCallbacks {
  onInteraction: (interaction: ActiveInteraction) => void
  onInteractionDismissed: (requestId: string) => void
  onBranchSwitch: (sessionId: SessionId, branchId: BranchId) => void
  onQueueSnapshot: (queue: QueueSnapshot) => void
}

type ToolResultEvent = Extract<AgentEvent, { _tag: "ToolCallSucceeded" | "ToolCallFailed" }>

interface SessionFeed {
  items: () => SessionItem[]
  messages: () => Message[]
  turnCount: () => number
  // eslint-disable-next-line effect/noNullish -- Solid accessor omits an inactive tool.
  activeTool: () => string | undefined
}

type SessionFeedClient = Pick<
  ClientContextValue,
  | "sessionIdentity"
  | "client"
  | "runtime"
  | "log"
  | "setConnectionIssue"
  | "waitForTransportReady"
  | "applySessionRuntime"
  | "applySessionSnapshot"
  | "applySessionEvent"
  | "applyBufferedSessionEvent"
>

type SessionFeedStore = {
  messages: Message[]
  events: SessionEvent[]
}

const isMessage = Predicate.or(
  Predicate.isTagged("regular-message"),
  Predicate.isTagged("interjection-message"),
)

// ── Build messages from raw ──

/**
 * A projected call as the feed's own mutable record. The live feed attaches
 * later operations to it, so its operations list is a fresh array.
 */
const toToolCall = ({ operations, ...call }: ToolInteraction): ToolCall => {
  if (Predicate.isUndefined(operations)) return { ...call }
  return { ...call, operations: operations.map((operation) => ({ ...operation })) }
}

/** Widen the projected segments with the tool payloads they name. */
const buildSegments = (
  projected: ReadonlyArray<MessageSegment>,
  toolCalls: ReadonlyArray<ToolCall>,
): AssistantSegment[] => {
  const interactionsById = new Map(toolCalls.map((call) => [String(call.id), call]))
  return projected.flatMap((segment) =>
    Match.value(segment).pipe(
      Match.tagsExhaustive({
        Text: (value): AssistantSegment[] => [{ _tag: "text", content: value.content }],
        Reasoning: (value): AssistantSegment[] => [{ _tag: "reasoning", content: value.content }],
        Image: (value): AssistantSegment[] => [
          { _tag: "image", image: { mediaType: value.mediaType } },
        ],
        ToolCall: (value): AssistantSegment[] => {
          const toolCall = Option.fromNullishOr(interactionsById.get(String(value.toolCallId)))
          if (Option.isNone(toolCall)) return []
          return [{ _tag: "tool-call", toolCall: toolCall.value }]
        },
      }),
    ),
  )
}

const buildMessages = (msgs: readonly ProjectedMessage[]): Message[] => {
  const filteredMsgs = msgs.filter((m) => m.role !== "tool")

  return filteredMsgs.map((m) => {
    const toolCalls = m.toolInteractions.map(toToolCall)
    let toolCallsOption = Option.none<typeof toolCalls>()
    if (toolCalls.length > 0) toolCallsOption = Option.some(toolCalls)
    let segments = Option.none<AssistantSegment[]>()
    if (m.role === "assistant") segments = Option.some(buildSegments(m.segments, toolCalls))
    if (m._tag === "interjection")
      return {
        _tag: "interjection-message",
        id: m.id,
        role: "user",
        content: messagePartsText(m.parts),
        reasoning: messagePartsReasoning(m.parts),
        images: messagePartsImages(m.parts),
        createdAt: m.createdAt.getTime(),
        toolCalls: Option.getOrUndefined(toolCallsOption),
        segments: Option.getOrUndefined(segments),
        metadata: m.metadata,
      }
    return {
      _tag: "regular-message",
      id: m.id,
      role: m.role,
      content: messagePartsText(m.parts),
      reasoning: messagePartsReasoning(m.parts),
      images: messagePartsImages(m.parts),
      createdAt: m.createdAt.getTime(),
      toolCalls: Option.getOrUndefined(toolCallsOption),
      segments: Option.getOrUndefined(segments),
      metadata: m.metadata,
    }
  })
}

const upsertReceivedMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  message: ProjectedMessage,
) => {
  const next = buildMessages([message])[0]
  const nextMessage = Option.fromNullishOr(next)
  if (Option.isNone(nextMessage)) return
  setStore(
    produce((draft) => {
      const index = draft.messages.findIndex((candidate) => candidate.id === nextMessage.value.id)
      if (index === -1) {
        draft.messages.push(nextMessage.value)
        return
      }
      draft.messages[index] = nextMessage.value
    }),
  )
}

const resolveRetryingEvents = (setStore: SetStoreFunction<SessionFeedStore>) => {
  setStore(
    produce((draft) => {
      for (const event of draft.events) {
        if (event._tag === "retrying") event.resolved = true
      }
    }),
  )
}

type MessageWithMetadata = {
  readonly metadata?: {
    readonly customType?: string
    readonly hidden?: boolean
  }
}

const isStandaloneMessage = (message: MessageWithMetadata): boolean =>
  message.metadata?.hidden === true

const appendSessionEvent = (setStore: SetStoreFunction<SessionFeedStore>, event: SessionEvent) => {
  setStore(
    produce((draft) => {
      draft.events.push(event)
    }),
  )
}

const ensureAssistantMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  content: string,
  id: string,
  createdAt: number,
) => {
  setStore(
    produce((draft) => {
      const last = draft.messages.find((message) => message.id === id)
      const lastMessage = Option.fromNullishOr(last)
      if (
        Option.isSome(lastMessage) &&
        lastMessage.value.role === "assistant" &&
        !isStandaloneMessage(lastMessage.value)
      ) {
        const assistant = lastMessage.value
        assistant.content += content
        // Append to last text segment or create new one
        const segments = Option.fromNullishOr(assistant.segments)
        if (Option.isSome(segments)) {
          const lastSeg = Option.fromNullishOr(segments.value[segments.value.length - 1])
          if (Option.isSome(lastSeg) && lastSeg.value._tag === "text") {
            lastSeg.value.content += content
          } else {
            segments.value.push({ _tag: "text", content })
          }
        }
        return
      }

      draft.messages.push({
        _tag: "regular-message",
        id,
        role: "assistant",
        content,
        reasoning: "",
        images: [],
        createdAt,
        toolCalls: Option.getOrUndefined(Option.none<ToolCall[]>()),
        segments: [{ _tag: "text", content }],
        metadata: Option.getOrUndefined(Option.none<Message["metadata"]>()),
      })
    }),
  )
}

const updateToolMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  updater: (message: Message) => void,
  matches: (message: Message) => boolean,
) => {
  setStore(
    produce((draft) => {
      const last = Option.fromNullishOr(
        draft.messages.findLast((message) => !isStandaloneMessage(message) && matches(message)),
      )
      if (Option.isNone(last) || last.value.role !== "assistant") return
      updater(last.value)
    }),
  )
}

/** Find a tool call by id among direct calls and cell-admitted operations. */
const locateToolCall = (
  calls: Option.Option<ReadonlyArray<ToolCall>>,
  toolCallId: string,
): Option.Option<ToolCall> => {
  if (Option.isNone(calls)) return Option.none()
  for (const call of calls.value) {
    if (call.id === toolCallId) return Option.some(call)
    const nested = locateToolCall(Option.fromNullishOr(call.operations), toolCallId)
    if (Option.isSome(nested)) return nested
  }
  return Option.none()
}

/** The tool calls a message shows inline, in segment order. */
const segmentToolCalls = (message: Message): Option.Option<ReadonlyArray<ToolCall>> =>
  Option.map(Option.fromNullishOr(message.segments), (segments) =>
    segments.flatMap((segment) => {
      if (segment._tag === "tool-call") return [segment.toolCall]
      return []
    }),
  )

/** Attach a cell-admitted call under its parent instead of the transcript top level. */
const attachOperation = (
  calls: Option.Option<ReadonlyArray<ToolCall>>,
  parentToolCallId: string,
  operation: ToolCall,
) => {
  const parent = locateToolCall(calls, parentToolCallId)
  if (Option.isNone(parent)) return
  let operations = Option.fromNullishOr(parent.value.operations)
  if (Option.isNone(operations)) {
    parent.value.operations = []
    operations = Option.fromNullishOr(parent.value.operations)
  }
  if (Option.isNone(operations)) return
  if (operations.value.some((call) => call.id === operation.id)) return
  operations.value.push(operation)
}

const applyToolCallResult = (
  call: Option.Option<ToolCall>,
  status: ToolCall["status"],
  toolEvent: ToolResultEvent,
  completedAt: number,
) => {
  if (Option.isNone(call)) return
  call.value.status = status
  call.value.summary = toolEvent.summary
  call.value.output = toolEvent.output
  if (Predicate.isNotUndefined(call.value.startedAt)) {
    call.value.durationMs = Math.max(0, completedAt - call.value.startedAt)
  }
}

const handleToolCallResult = (
  setStore: SetStoreFunction<SessionFeedStore>,
  setActiveTool: (value: Option.Option<string>) => void,
  toolEvent: ToolResultEvent,
  completedAt: number,
) => {
  let status: "error" | "completed" = "completed"
  if (toolEvent._tag === "ToolCallFailed") status = "error"

  if (Predicate.isUndefined(toolEvent.parentToolCallId)) setActiveTool(Option.none())
  updateToolMessage(
    setStore,
    (message) => {
      applyToolCallResult(
        locateToolCall(Option.fromNullishOr(message.toolCalls), toolEvent.toolCallId),
        status,
        toolEvent,
        completedAt,
      )
      // The same call also renders inline as a segment.
      applyToolCallResult(
        locateToolCall(segmentToolCalls(message), toolEvent.toolCallId),
        status,
        toolEvent,
        completedAt,
      )
    },
    (message) =>
      Option.isSome(locateToolCall(Option.fromNullishOr(message.toolCalls), toolEvent.toolCallId)),
  )
}

const toActiveInteraction = (event: AgentEvent): Option.Option<ActiveInteraction> => {
  if (event._tag === "InteractionPresented") return Option.some(event)
  return Option.none()
}

/**
 * Events whose effect the session snapshot already carries. Replay skips them
 * so a reload does not re-count turns or re-append settled tool payloads.
 */
const isSnapshotHeldEvent = Predicate.or(
  Predicate.isTagged("StreamChunk"),
  Predicate.or(
    Predicate.isTagged("ToolCallStarted"),
    Predicate.or(Predicate.isTagged("ToolCallSucceeded"), Predicate.isTagged("ToolCallFailed")),
  ),
)

const isToolResultEvent = Predicate.or(
  Predicate.isTagged("ToolCallSucceeded"),
  Predicate.isTagged("ToolCallFailed"),
)

type ToolStartedEvent = Extract<AgentEvent, { _tag: "ToolCallStarted" }>

/** The status-line label for a running tool: its name plus a short input. */
const activeToolLabel = (event: ToolStartedEvent): string => {
  const inputSummary = formatToolInput(event.toolName, event.input)
  if (inputSummary.length === 0) return event.toolName
  return `${event.toolName}(${inputSummary})`
}

/** Put a new call on its owning message, or under the cell that admitted it. */
const startToolCall = (
  setStore: SetStoreFunction<SessionFeedStore>,
  event: ToolStartedEvent,
  startedAt: number,
) => {
  const toolCall = {
    id: event.toolCallId,
    toolName: event.toolName,
    status: "running",
    input: event.input,
    summary: Option.getOrUndefined(Option.none<string>()),
    output: Option.getOrUndefined(Option.none<string>()),
    startedAt,
  } satisfies ToolCall
  const parentToolCallId = Option.fromUndefinedOr(event.parentToolCallId)
  updateToolMessage(
    setStore,
    (message) => {
      if (Option.isSome(parentToolCallId)) {
        attachOperation(Option.fromNullishOr(message.toolCalls), parentToolCallId.value, toolCall)
        attachOperation(segmentToolCalls(message), parentToolCallId.value, { ...toolCall })
        return
      }
      const existing = Option.fromNullishOr(message.toolCalls)
      // Cold interaction resume starts the same call again, not a new call.
      if (Option.isSome(existing) && existing.value.some((call) => call.id === event.toolCallId))
        return
      if (Option.isNone(existing)) message.toolCalls = []
      message.toolCalls?.push(toolCall)
      // Also push to segments for interleaved rendering.
      if (Option.isNone(Option.fromNullishOr(message.segments))) message.segments = []
      message.segments?.push({ _tag: "tool-call", toolCall })
    },
    (message) => {
      if (Option.isSome(parentToolCallId)) {
        return Option.isSome(
          locateToolCall(Option.fromNullishOr(message.toolCalls), parentToolCallId.value),
        )
      }
      // A late receipt names the message it belongs to; it must not land on a newer one.
      if (Predicate.isNotUndefined(event.assistantMessageId))
        return message.id === event.assistantMessageId
      return true
    },
  )
}

/** A send that fails is tried again four times, from 200 ms, before the shell takes the prompt back. */
const STARTUP_PROMPT_RETRY = { schedule: Schedule.exponential("200 millis"), times: 4 }

// ── Hook ──

export function useSessionFeed(
  sessionId: () => SessionId,
  branchId: () => BranchId,
  client: SessionFeedClient,
  cast: <A, E>(effect: Effect.Effect<A, E, never>) => void,
  callbacks: SessionFeedCallbacks,
  /** Read at send time, so the owner decides whether the prompt is still unsent. */
  takeInitialPrompt?: () => Option.Option<StartupPrompt>,
  canSendPrompt?: () => boolean,
): SessionFeed {
  const [store, setStore] = createStore<{ messages: Message[]; events: SessionEvent[] }>({
    messages: [],
    events: [],
  })
  const [turnCount, setTurnCount] = createSignal(0)
  const [activeTool, setActiveTool] = createSignal<Option.Option<string>>(Option.none())
  const [streamReadyKey, setStreamReadyKey] = createSignal<Option.Option<string>>(Option.none())
  let streamMessageId = Option.none<string>()
  let eventSeq = 0
  // The steps of the turn in flight; TurnCompleted spends them on its label.
  let turnSteps = emptyTurnSteps
  const takeTurnSteps = () => {
    const steps = turnSteps
    turnSteps = emptyTurnSteps
    return steps
  }
  /**
   * Every event that needs no streaming state: a message, a turn boundary, a
   * tool start, or a transcript notice.
   */
  const applySettledEvent = (
    event: AgentEvent,
    receivedAt: number,
    stampedAt: number,
    live: boolean,
  ) => {
    switch (event._tag) {
      case "MessageReceived":
        // A replayed message is already in the snapshot unless it is standalone.
        if (isStandaloneMessage(event.message) || (live && event.message.role === "user")) {
          upsertReceivedMessage(setStore, projectMessage(event.message, []))
        }
        return

      case "StreamEnded":
        streamMessageId = Option.none()
        turnSteps = addStep(turnSteps, event)
        return

      case "TurnCompleted":
        streamMessageId = Option.none()
        resolveRetryingEvents(setStore)
        appendTurnEndRow(event, stampedAt)
        return

      case "ToolCallStarted":
        setActiveTool(Option.some(activeToolLabel(event)))
        startToolCall(setStore, event, receivedAt)
        return

      case "ProviderRetrying":
        if (live) resolveRetryingEvents(setStore)
        appendSessionEvent(setStore, {
          _tag: "retrying",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          resolved: false,
          createdAt: stampedAt,
          seq: eventSeq++,
        })
        return

      case "ErrorOccurred":
        resolveRetryingEvents(setStore)
        if (live) client.log.error("sessionFeed.error", { error: event.error, seq: eventSeq })
        appendSessionEvent(setStore, {
          _tag: "error",
          error: event.error,
          createdAt: stampedAt,
          seq: eventSeq++,
        })
        return

      default:
        return
    }
  }

  /** Hand an interaction event to the composer. Reports whether it consumed the event. */
  const routeInteraction = (event: AgentEvent): boolean => {
    if (event._tag === "InteractionResolved") {
      callbacks.onInteractionDismissed(event.requestId)
      return true
    }
    const interaction = toActiveInteraction(event)
    if (Option.isNone(interaction)) return false
    callbacks.onInteraction(interaction.value)
    return true
  }

  /**
   * Start the message this turn's answer belongs to. The durable input id and
   * step name it, so a later chunk or receipt finds the same owner.
   */
  const openStreamedAnswer = (
    event: Extract<AgentEvent, { _tag: "StreamStarted" }>,
    stampedAt: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const id = yield* Option.fromUndefinedOr(event.messageId).pipe(
        Option.match({
          onNone: () => randomId,
          onSome: (inputId) => Effect.succeed(assistantMessageIdForTurn(inputId, event.step)),
        }),
      )
      streamMessageId = Option.some(id)
      ensureAssistantMessage(setStore, "", id, stampedAt)
    })

  /** A chunk extends the open answer. A history stream without one gets a local id. */
  const appendStreamedChunk = (chunk: string, stampedAt: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const id = yield* streamMessageId.pipe(
        Option.match({ onNone: () => randomId, onSome: Effect.succeed }),
      )
      streamMessageId = Option.some(id)
      ensureAssistantMessage(setStore, chunk, id, stampedAt)
    })

  /** The transcript row that closes a turn: an interruption or a duration. */
  const appendTurnEndRow = (
    event: Extract<AgentEvent, { _tag: "TurnCompleted" }>,
    stampedAt: number,
  ) => {
    const steps = takeTurnSteps()
    if (event.interrupted === true) {
      appendSessionEvent(setStore, { _tag: "interruption", createdAt: stampedAt, seq: eventSeq++ })
      return
    }
    const durationSeconds = Math.round(event.durationMs / 1000)
    // A turn shorter than a second gets no row.
    if (durationSeconds <= 0) return
    appendSessionEvent(setStore, {
      _tag: "turn-ended",
      durationSeconds,
      steps,
      createdAt: stampedAt,
      seq: eventSeq++,
    })
  }
  const lastSeenEventIdByKey = new Map<string, number>()
  let processedEnvelopeIds = new Set<EventEnvelope["id"]>()

  // Track the active key to guard against stale async writes and reset prompt state
  let currentKey = Option.none<string>()
  const takeInitialPromptValue = Option.fromNullishOr(takeInitialPrompt)
  const canSendPromptValue = Option.fromNullishOr(canSendPrompt)

  const resetProjection = () => {
    setStore({ messages: [], events: [] })
    setTurnCount(0)
    setActiveTool(Option.none())
    setStreamReadyKey(Option.none())
    streamMessageId = Option.none()
    eventSeq = 0
    processedEnvelopeIds = new Set()
  }

  const items = createMemo((): SessionItem[] => {
    const combined: SessionItem[] = [...store.messages, ...store.events]
    return combined.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (!isMessage(a) && !isMessage(b)) return a.seq - b.seq
      if (a._tag === b._tag) return 0
      if (isMessage(a)) return -1
      return 1
    })
  })

  // Keyed subscription — re-runs only when sessionId:branchId identity changes
  const feedKey = createMemo(() => `${sessionId()}:${branchId()}`)

  // Wait for session to become active before subscribing
  const activeSessionKey = createMemo(
    (): Option.Option<string> =>
      Option.map(
        client.sessionIdentity(),
        (identity) => `${identity.sessionId}:${identity.branchId}`,
      ),
    Option.none(),
    { equals: Equal.equals },
  )

  const canSendPromptNow = () =>
    Option.getOrElse(
      Option.map(canSendPromptValue, (check) => check()),
      () => true,
    )

  createEffect(
    on(
      [activeSessionKey, feedKey, streamReadyKey, canSendPromptNow],
      ([active, key, readyKey, canSend]) => {
        if (Option.isNone(active) || active.value !== key) return
        if (Option.isNone(readyKey) || readyKey.value !== key || !canSend) return
        const startup = Option.flatMap(takeInitialPromptValue, (take) => take())
        if (Option.isNone(startup)) return
        const prompt = startup.value
        if (prompt.content === "") return

        const session = sessionId()
        const branch = branchId()
        client.log.info("feed.sendInitialPrompt", {
          sessionId: session,
          branchId: branch,
        })
        client.runtime.cast(
          Effect.gen(function* () {
            const requestId = yield* Option.match(prompt.requestId, {
              onNone: () => randomId,
              onSome: Effect.succeed,
            })
            yield* client.client.message
              .send({ sessionId: session, branchId: branch, content: prompt.content, requestId })
              .pipe(
                // One request id for every attempt, so an attempt that landed
                // with a lost reply cannot run the prompt a second time.
                Effect.retry(STARTUP_PROMPT_RETRY),
                Effect.andThen(Effect.sync(() => prompt.settle(true, requestId))),
                Effect.catchEager((err) =>
                  Effect.sync(() => {
                    // The shell holds the prompt again; the next ready stream sends it.
                    prompt.settle(false, requestId)
                    if (Option.isNone(currentKey) || currentKey.value !== key) return
                    client.setConnectionIssue(formatConnectionIssue(err))
                  }),
                ),
              )
          }),
        )
      },
    ),
  )

  createEffect(
    on([activeSessionKey, feedKey], ([active, key]) => {
      if (Option.isNone(active) || active.value !== key) return

      // Reset all projection state on identity change
      if (Option.isNone(currentKey) || currentKey.value !== key) {
        resetProjection()
        currentKey = Option.some(key)
      }

      const branch = branchId()
      const session = sessionId()
      client.log.info("feed.activate", { key })

      const streamFiber = client.runtime.fork(
        Effect.scoped(
          runWithReconnect(
            () =>
              Effect.gen(function* () {
                client.log.info("feed.snapshot.fetch", { key })
                const snapshot = yield* client.client.session.getSnapshot({
                  sessionId: session,
                  branchId: branch,
                })
                // Pending-interaction hydration on session entry now comes from
                // event-stream replay via the `after` cursor below — there is no
                // more privileged extension-snapshot side-channel. If the
                // interaction extension wants explicit hydration, it should
                // expose a typed query the client polls on session entry.

                client.log.info("feed.snapshot.hydrated", {
                  key,
                  messageCount: snapshot.messages.length,
                  lastEventId: snapshot.lastEventId,
                })

                const snapshotApplied = yield* Effect.sync(() => {
                  if (Option.isNone(currentKey) || currentKey.value !== key) return false
                  client.applySessionSnapshot(snapshot)
                  callbacks.onQueueSnapshot(snapshot.runtime.queue)
                  setStore("messages", buildMessages(snapshot.messages))
                  return true
                })
                if (!snapshotApplied) return yield* Effect.never

                const after = Option.getOrElse(
                  Option.fromNullishOr(lastSeenEventIdByKey.get(key)),
                  () => 0,
                )

                const eventStream = client.client.session.events({
                  sessionId: session,
                  branchId: branch,
                  after,
                })

                client.log.info("feed.stream.open", { key, after })
                const eventsFiber = yield* eventStream.pipe(
                  Stream.runForEach((envelope) =>
                    Effect.gen(function* () {
                      if (Option.isNone(currentKey) || currentKey.value !== key) return
                      client.setConnectionIssue(Option.getOrNull(Option.none()))
                      yield* processEnvelope(
                        envelope,
                        branch,
                        key,
                        Option.fromNullishOr(snapshot.lastEventId),
                      )
                    }),
                  ),
                  Effect.forkScoped,
                )
                const runtimeFiber = yield* client.client.session
                  .watchRuntime({
                    sessionId: session,
                    branchId: branch,
                  })
                  .pipe(
                    Stream.runForEach((next) =>
                      Effect.sync(() => {
                        if (Option.isNone(currentKey) || currentKey.value !== key) return
                        client.setConnectionIssue(Option.getOrNull(Option.none()))
                        if (next._tag === "Idle") resolveRetryingEvents(setStore)
                        client.applySessionRuntime({
                          sessionId: session,
                          branchId: branch,
                          runtime: next,
                        })
                        callbacks.onQueueSnapshot(next.queue)
                      }),
                    ),
                    Effect.forkScoped,
                  )

                yield* Effect.sync(() => {
                  if (Option.isNone(currentKey) || currentKey.value !== key) return
                  setStreamReadyKey(Option.some(key))
                })

                return yield* Effect.raceFirst(Fiber.join(eventsFiber), Fiber.join(runtimeFiber))
              }),
            {
              label: "feed.events",
              log: client.log,
              onError: (err) => {
                if (Option.isNone(currentKey) || currentKey.value !== key) return
                client.log.error("feed.error", {
                  key,
                  error: formatConnectionIssue(err),
                })
                client.setConnectionIssue(formatConnectionIssue(err))
              },
              waitForRetry: () => client.waitForTransportReady,
            },
          ),
        ),
      )

      onCleanup(() => {
        client.log.info("feed.cleanup", { key })
        client.runtime.cast(Fiber.interrupt(streamFiber))
      })
    }),
  )

  const processEnvelope = (
    envelope: EventEnvelope,
    branch: BranchId,
    key: string,
    snapshotLastEventId: Option.Option<number>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Drop events if identity changed
      if (Option.isNone(currentKey) || currentKey.value !== key) return
      if (envelope.event._tag === "StreamSynchronized") {
        // Replay is complete; later envelopes are live. The marker shares the cursor id
        // with the last replayed event, so it must not enter the duplicate set.
        const lastSeen = Option.getOrElse(
          Option.fromNullishOr(lastSeenEventIdByKey.get(key)),
          () => 0,
        )
        lastSeenEventIdByKey.set(key, Math.max(lastSeen, envelope.event.lastEventId))
        client.log.info("feed.stream.synchronized", {
          key,
          lastEventId: envelope.event.lastEventId,
        })
        return
      }
      if (processedEnvelopeIds.has(envelope.id)) {
        client.log.debug("feed.event.duplicate", { key, eventId: envelope.id })
        return
      }
      processedEnvelopeIds.add(envelope.id)
      const lastSeen = Option.getOrElse(
        Option.fromNullishOr(lastSeenEventIdByKey.get(key)),
        () => 0,
      )
      lastSeenEventIdByKey.set(key, Math.max(lastSeen, envelope.id))
      if (Option.isSome(snapshotLastEventId) && envelope.id <= snapshotLastEventId.value) {
        // Historical navigation must not replace the branch selected for this snapshot.
        if (envelope.event._tag === "BranchSwitched") return
        client.applyBufferedSessionEvent(envelope)
        yield* processEvent(envelope, key, "replay")
        return
      }
      const event = envelope.event
      if (event._tag === "BranchSwitched") {
        // Changing client identity stops this subscription. Route before cleanup.
        batch(() => {
          client.applySessionEvent(envelope)
          if (event.toBranchId !== branch) {
            setStore({ messages: [], events: [] })
            callbacks.onBranchSwitch(event.sessionId, event.toBranchId)
          }
        })
        return
      }
      client.applySessionEvent(envelope)
      yield* processEvent(envelope, key, "live")
    })

  /**
   * One event handler for both passes.
   *
   * `replay` covers envelopes at or before the snapshot cursor: the snapshot
   * already holds their message, tool, and metric state, so replay only
   * rebuilds the event-only UI rows and stamps them with the recorded time.
   * `live` covers everything after it and stamps rows with the current time so
   * they sort after the snapshot's own rows.
   */
  const processEvent = (
    envelope: EventEnvelope,
    key: string,
    pass: "replay" | "live",
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const event = envelope.event
      if (Option.isNone(currentKey) || currentKey.value !== key) return
      const live = pass === "live"
      if (live) client.log.debug("feed.event", { key, tag: event._tag })
      // A replayed row keeps the time it happened; a live row takes the clock.
      let stampedAt = envelope.createdAt
      if (live) stampedAt = yield* Clock.currentTimeMillis

      // Interactions belong to the composer, not the transcript.
      if (routeInteraction(event)) return

      // The snapshot carries every settled message, tool result, and metric.
      if (!live && isSnapshotHeldEvent(event)) return

      if (isToolResultEvent(event)) {
        handleToolCallResult(setStore, setActiveTool, event, envelope.createdAt)
        return
      }

      switch (event._tag) {
        case "StreamStarted":
          resolveRetryingEvents(setStore)
          if (!live) break
          setTurnCount((n) => n + 1)
          setActiveTool(Option.none())
          yield* openStreamedAnswer(event, stampedAt)
          break

        case "StreamChunk":
          yield* appendStreamedChunk(event.chunk, stampedAt)
          break

        default:
          applySettledEvent(event, envelope.createdAt, stampedAt, live)
          break
      }
    })

  return {
    items,
    messages: () => store.messages,
    turnCount,
    activeTool: () => Option.getOrUndefined(activeTool()),
  }
}

// ── session controller ──────────────────────────────────────────────────────

export interface SessionController {
  items: () => SessionItem[]
  messages: () => Message[]
  forkMessages: () => readonly DurableMessage[]
  queueState: () => QueueState
  composerState: () => ComposerState
  interactionState: () => ComposerInteractionState
  saveDraft: (draft: ComposerDraft) => void
  uiState: () => ReturnType<typeof SessionUiState.initial>
  /** The `ctrl+r` palette: its state, its entries, and its key handling. */
  promptSearch: PromptSearchController
  activity: () =>
    | { phase: "idle"; turn: number }
    | { phase: "thinking"; turn: number }
    | { phase: "tool"; turn: number; toolInfo: string }
  phaseLabel: () => string
  elapsed: () => number
  onComposerInteraction: (event: ComposerInteractionEvent) => void
  onSubmit: (content: string, mode?: "queue" | "interject") => void
  onSlashCommand: (cmd: string, args: string) => Effect.Effect<void>
  onRestoreQueue: () => void
  dispatchComposer: (event: ComposerEvent) => void
  resolveAuthGate: () => void
  closeOverlay: () => void
  /** The name the picker shows, and the name a branch switch keeps. */
  currentSessionName: () => string
  /** Escape in the branch picker: close it, or quit if the boot flow opened it. */
  onBranchPickerDismiss: () => void
  onBranchPickerSelect: (branchId: BranchId) => void
  onForkSelect: (messageId: MessageId) => void
  onModelSelect: (modelId: ModelId) => void
  /** `None` clears the session override so config/agent defaults apply. */
  onReasoningSelect: (level: Option.Option<ReasoningEffort>) => void
}

export function createSessionController(props: {
  sessionId: SessionId
  branchId: BranchId
  /**
   * Branches to dock the picker over at boot. Present only for the first
   * session the process mounts, when the resumed session has more than one
   * loop to choose between.
   */
  initialBranches: Option.Option<readonly Branch[]>
  debugMode?: boolean
  missingAuthProviders?: readonly string[]
}): SessionController {
  const client = useClient()
  const command = useCommand()
  const ext = useExtensionUI()
  const shell = useSessionShell()
  const { cast } = useRuntime()
  const renderer = useRenderer()
  const env = useEnv()
  const exit = () => {
    // The session id is the only way back into this conversation, and it is
    // about to leave the screen. Printed after the renderer is destroyed so it
    // lands in the terminal the reader keeps, not in the alternate screen.
    const leaving = Option.fromNullishOr(client.session())
    shutdownLog("exit.renderer-destroy")
    renderer.destroy()
    Option.match(leaving, {
      onNone: () => {},
      onSome: (session) => {
        // eslint-disable-next-line effect/noGlobals -- The line must reach the real terminal after the renderer is destroyed, outside any Effect.
        process.stdout.write(`\nto resume: gent resume ${session.sessionId}\n`)
      },
    })
    shutdownLog("exit.shutdown-signal")
    env.shutdown()
  }
  // Escape twice within a second quits. The first press arms the quit (and
  // clears a draft); a keybind, an interrupt, or any other use of escape
  // disarms it.
  const QUIT_WINDOW_MS = 1_000
  let quitArmedAt = Option.none<number>()
  const disarmQuit = () => {
    quitArmedAt = Option.none()
  }
  const pressQuit = (first: () => void) => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
    if (Option.exists(quitArmedAt, (at) => now - at < QUIT_WINDOW_MS)) {
      disarmQuit()
      exit()
      return
    }
    quitArmedAt = Option.some(now)
    first()
  }
  const history = usePromptHistory()
  const frecency = useAutocompleteFrecency()

  const currentSessionName = (): string =>
    Option.getOrElse(
      Option.flatMap(Option.fromNullishOr(client.session()), (value) =>
        Option.fromNullishOr(value.name),
      ),
      () => "Unnamed",
    )

  // ── Branch picker ──
  //
  // The boot flow opens the pane over the session it just mounted on its
  // active branch. Until a branch is chosen, nothing behind the pane may act
  // on the reader's behalf: the startup prompt waits and the auth gate holds,
  // because both are about a branch the reader has not picked yet.

  const [uiState, setUiState] = createSignal(SessionUiState.initial(props.initialBranches))

  /**
   * Whether the reader still owes this session a branch.
   *
   * The overlay is the one owner, so the pane and this gate cannot disagree.
   * It is a memo rather than a plain read because the auth gate also writes
   * the overlay: a memo only notifies when its own boolean changes, so the
   * gate's `OpenAuth` leaves this `false` and never re-runs the auth check on
   * its own effect.
   */
  const branchPickerOpen = createMemo(() => uiState().overlay._tag === "branches")

  // ── Auth gate ──
  const [controllerState, setControllerState] = createSignal(
    initialSessionControllerState({
      debugMode: props.debugMode,
      missingAuthProviders: props.missingAuthProviders,
      agent: client.agent(),
    }),
  )
  const authGateState = () => controllerState().authGate
  const validatedAgent = () => controllerState().validatedAgent
  const queueState = () => controllerState().queue
  const elapsed = () => controllerState().elapsed
  const updateControllerState = (
    update: (state: ReturnType<typeof controllerState>) => ReturnType<typeof controllerState>,
  ) => setControllerState((current) => update(current))
  createEffect(
    on(
      [() => client.agent(), branchPickerOpen],
      ([agentName, pickerOpen]) => {
        if (props.debugMode) return
        if (pickerOpen) return
        Option.match(Option.fromNullishOr(agentName), {
          onNone: () => {},
          onSome: (resolvedAgent) => {
            const version = controllerState().authCheckVersion + 1
            updateControllerState(beginAuthCheck)
            client.runtime.cast(
              client.client.auth
                .listProviders({ agentName: resolvedAgent, sessionId: props.sessionId })
                .pipe(
                  Effect.tap((providers) =>
                    Effect.sync(() => {
                      const missing = providers.some((p) => p.required && !p.hasKey)
                      updateControllerState((state) =>
                        completeAuthCheck(state, {
                          version,
                          agent: resolvedAgent,
                          missing,
                        }),
                      )
                    }),
                  ),
                  Effect.catchEager((error) =>
                    Effect.sync(() => {
                      updateControllerState((state) => failAuthCheck(state, version))
                      client.setError(`Authentication check failed: ${formatAuthGateError(error)}`)
                    }),
                  ),
                ),
            )
          },
        })
      },
      { defer: false },
    ),
  )

  const authGatePending = () =>
    !props.debugMode && (authGateState() !== "closed" || validatedAgent() !== client.agent())

  const [composerState, setComposerState] = createSignal<ComposerState>(ComposerState.idle())
  const drafts = useComposerDrafts()
  const draftBranchId = props.branchId
  const [interactionState, setInteractionState] = createSignal({
    ...ComposerInteractionState.initial(),
    ...Option.getOrElse(drafts.get(draftBranchId), ComposerInteractionState.initial),
  })
  let activityStartTime = currentMillis()

  const handleSessionUiEffect = (effect: SessionUiEffect) => {
    if (effect._tag === "RestoreComposer") {
      setInteractionState((current) =>
        transitionComposerInteraction(
          current,
          ComposerInteractionEvent.cases.RestoreDraft.make({ text: effect.text }),
        ),
      )
    }
  }

  const dispatchSessionUi = (event: SessionUiEvent) => {
    const result = transitionSessionUi(uiState(), event)
    setUiState(result.state)
    for (const effect of result.effects) handleSessionUiEffect(effect)
  }

  /**
   * Escape leaves the picker, not the list. The boot flow is where a session
   * with several branches starts, so with no branch chosen the only way out
   * is to quit — the same exit the picker route had.
   */
  const onBranchPickerDismiss = () => {
    exit()
  }

  const onBranchPickerSelect = (branchId: BranchId) => {
    dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))
    if (branchId === props.branchId) return
    client.switchSession(props.sessionId, branchId, currentSessionName())
  }

  createEffect(() => {
    if (branchPickerOpen()) return
    if (isBlockingAuthGate(authGateState()) && uiState().overlay._tag !== "auth") {
      dispatchSessionUi(SessionUiEvent.cases.OpenAuth.make({ enforceAuth: true }))
    }
  })

  // The session's overlay is the one pane owner; client extensions open and
  // close their panes through the host, which forwards here.
  ext.setPaneOwner(
    Option.some({
      open: (id) => dispatchSessionUi(SessionUiEvent.cases.OpenPane.make({ id })),
      close: (id) => dispatchSessionUi(SessionUiEvent.cases.ClosePane.make({ id })),
      isOpen: (id) => {
        const overlay = uiState().overlay
        return overlay._tag === "pane" && overlay.id === id
      },
    }),
  )
  onCleanup(() => ext.setPaneOwner(Option.none()))

  ext.setActivityProvider(() => {
    const session = Option.fromNullishOr(client.session())
    const sessionId = Option.getOrUndefined(Option.map(session, (value) => value.sessionId))
    const connection = Option.fromNullishOr(client.connectionState())
    if (
      client.isLoading() ||
      client.isReconnecting() ||
      (Option.isSome(connection) && connection.value._tag === "Disconnected")
    )
      return { sessionId, state: "unknown" }
    if (
      isBlockingAuthGate(authGateState()) ||
      composerState()._tag === "interaction" ||
      client.isError()
    ) {
      return { sessionId, state: "blocked" }
    }
    if (client.isStreaming()) return { sessionId, state: "working" }
    return { sessionId, state: "idle" }
  })

  const handleComposerEffect = (effect: Option.Option<ComposerEffect>) => {
    if (Option.isNone(effect)) return
    const { interaction, result } = effect.value
    const request = {
      requestId: interaction.requestId,
      sessionId: props.sessionId,
      branchId: props.branchId,
      approved: result.approved,
    }
    const requestWithNotes = Option.match(Option.fromNullishOr(result.notes), {
      onNone: () => request,
      onSome: (notes) => ({ ...request, notes }),
    })
    const requestWithContent = Option.match(Option.fromUndefinedOr(result.editedContent), {
      onNone: () => requestWithNotes,
      onSome: (editedContent) => ({ ...requestWithNotes, editedContent }),
    })
    cast(
      client.client.interaction.respondInteraction(requestWithContent).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            client.setError(formatError(error))
          }),
        ),
      ),
    )
  }

  const dispatchComposer = (event: ComposerEvent) => {
    const result = transition(composerState(), event)
    setComposerState(result.state)
    handleComposerEffect(Option.fromNullishOr(result.effect))
  }

  const onInteraction = (interaction: ActiveInteraction) => {
    dispatchComposer(ComposerEvent.cases.EnterInteraction.make({ interaction }))
  }

  const onComposerInteraction = (event: ComposerInteractionEvent) => {
    setInteractionState((current) =>
      transitionComposerInteraction(current, event, ext.autocompleteItems()),
    )
  }

  const feed = useSessionFeed(
    () => props.sessionId,
    () => props.branchId,
    client,
    cast,
    {
      onInteraction,
      onInteractionDismissed: (requestId) => {
        dispatchComposer(ComposerEvent.cases.DismissInteraction.make({ requestId }))
      },
      onBranchSwitch: (sessionId, branchId) => {
        client.switchSession(sessionId, branchId, currentSessionName())
      },
      onQueueSnapshot: (queue) => updateControllerState((state) => setQueue(state, queue)),
    },
    () => shell.takePrompt(props.sessionId),
    // Gate prompt send on auth resolution and on the branch picker — the feed
    // waits for the stream plus this signal.
    () => !authGatePending() && !branchPickerOpen(),
  )

  const items = createMemo<SessionItem[]>(() => feed.items())
  const promptSearch = createPromptSearchController({
    state: () => {
      const overlay = uiState().overlay
      if (overlay._tag === "prompt-search") return overlay.state
      return PromptSearchState.closed()
    },
    entries: history.entries,
    draft: () => interactionState().draft,
    dispatch: (event) => dispatchSessionUi(SessionUiEvent.cases.PromptSearch.make({ event })),
  })

  const activity = (): ReturnType<SessionController["activity"]> => {
    if (!client.isStreaming()) return { phase: "idle", turn: feed.turnCount() }
    const tool = Option.fromNullishOr(feed.activeTool())
    if (Option.isSome(tool)) {
      return { phase: "tool", turn: feed.turnCount(), toolInfo: tool.value }
    }
    return { phase: "thinking", turn: feed.turnCount() }
  }

  createEffect(() => {
    const nextActivity = activity()
    activityStartTime = currentMillis()
    updateControllerState((state) => setControllerElapsed(state, 0))

    if (nextActivity.phase === "idle") return

    const fiber = client.runtime.fork(
      Effect.sync(() => {
        updateControllerState((state) =>
          setControllerElapsed(state, currentMillis() - activityStartTime),
        )
      }).pipe(Effect.repeat(Schedule.spaced("1 second"))),
    )
    onCleanup(() => {
      client.runtime.cast(Fiber.interrupt(fiber))
    })
  })

  let thinkingWord = "thinking"
  createEffect(
    on(
      () => activity().phase,
      (phase) => {
        if (phase !== "idle") {
          client.runtime.cast(
            Effect.gen(function* () {
              const wordRandom = yield* Random.next
              yield* Effect.sync(() => {
                thinkingWord = pickThinkingWord(wordRandom)
              })
            }),
          )
        }
      },
    ),
  )

  const phaseLabel = createMemo(() => {
    const nextActivity = activity()
    switch (nextActivity.phase) {
      case "idle":
        if (nextActivity.turn > 0) return "idle"
        return "ready"
      case "thinking":
        return thinkingWord
      case "tool":
        return nextActivity.toolInfo
    }
  })

  const openForkPicker = () => {
    const sessionId = props.sessionId
    const branchId = props.branchId
    cast(
      client.client.message.list({ branchId }).pipe(
        Effect.tap((messages) =>
          Effect.sync(() => {
            if (props.sessionId !== sessionId || props.branchId !== branchId) return
            if (messages.length === 0) {
              client.setError("No messages to fork")
              return
            }
            dispatchSessionUi(SessionUiEvent.cases.OpenFork.make({ messages }))
          }),
        ),
        client.surfaceError,
      ),
    )
  }

  createSessionCommandRegistry({
    client,
    ext,
    cast,
    frecency: () => frecency.lookup(),
    recordPick: (id: string) => frecency.record("/", id),
    resetFrecency: () => frecency.reset(),
    openForkPicker,
    openModelPicker: () =>
      dispatchSessionUi(SessionUiEvent.cases.OpenSettingsPicker.make({ picker: "model" })),
    openReasoningPicker: () =>
      dispatchSessionUi(SessionUiEvent.cases.OpenSettingsPicker.make({ picker: "reasoning" })),
    openAuth: () => dispatchSessionUi(SessionUiEvent.cases.OpenAuth.make({ enforceAuth: false })),
  })

  const onRestoreQueue = () => {
    cast(
      client.drainQueuedMessages.pipe(
        Effect.tap(({ steering, followUp }) =>
          Effect.sync(() => {
            const text = Option.fromNullishOr(queuedDraftText({ steering, followUp }))
            if (Option.isNone(text)) return
            onComposerInteraction(
              ComposerInteractionEvent.cases.RestoreDraft.make({
                text: text.value,
              }),
            )
            updateControllerState(clearQueue)
          }),
        ),
        client.surfaceError,
      ),
    )
  }

  const closeOverlay = () => dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))

  const resolveAuthGate = () => {
    updateControllerState((state) => closeAuthGateState(state, client.agent()))
    closeOverlay()
  }

  const onSlashCommand = (cmd: string, args: string): Effect.Effect<void> =>
    Effect.sync(() => {
      const result = executeSlashCommand(cmd, args, ext.commands())
      Option.match(Option.fromNullishOr(result.error), {
        onNone: () => {},
        onSome: (error) => client.setError(error),
      })
    })

  const onModelSelect = (modelId: ModelId) => {
    closeOverlay()
    cast(
      client
        .updateSessionSettings((current) => ({ ...current, modelId }))
        .pipe(client.surfaceError),
    )
  }

  const onReasoningSelect = (level: Option.Option<ReasoningEffort>) => {
    closeOverlay()
    cast(
      client
        .updateSessionSettings((current) => ({
          ...current,
          reasoningLevel: Option.getOrUndefined(level),
        }))
        .pipe(client.surfaceError),
    )
  }

  const onForkSelect = (messageId: MessageId) => {
    dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))
    cast(
      client.forkBranch(messageId).pipe(
        Effect.tap((branchId) =>
          Effect.sync(() => {
            client.switchBranch(branchId)
          }),
        ),
        client.surfaceError,
      ),
    )
  }

  const onSubmit = (content: string, mode?: "queue" | "interject") => {
    if (mode === "interject" && client.isStreaming()) {
      client.steer(
        SteerCommandInput.cases.Interject.make({ message: content, agent: client.agent() }),
      )
      return
    }
    client.sendMessage(content)
  }

  const clearMessages = () => {
    dispatchSessionUi(SessionUiEvent.cases.ClearDisplay.make({}))
  }

  const handleTranscriptKey = (event: ScopedKeyboardEvent) => {
    if (event.ctrl !== true) return false
    if (event.name === "l") {
      clearMessages()
      return true
    }
    if (event.name !== "o") return false
    // ctrl+o walks collapsed → preview → full inline; ctrl+shift+o opens the full transcript.
    if (event.shift === true) {
      dispatchSessionUi(SessionUiEvent.cases.ToggleTranscript.make({}))
    } else {
      dispatchSessionUi(SessionUiEvent.cases.CycleDisclosure.make({}))
    }
    return true
  }

  const handleInterrupt = () => {
    disarmQuit()
    if (overlayHoldsComposer(uiState().overlay)) {
      exit()
      return
    }
    if (uiState().transcriptExpanded) {
      dispatchSessionUi(SessionUiEvent.cases.ToggleTranscript.make({}))
      return
    }
    if (interactionState().draft.length > 0) {
      onComposerInteraction(ComposerInteractionEvent.cases.ClearDraft.make({}))
      return
    }
    if (client.isStreaming()) {
      client.steer(SteerCommandInput.cases.Cancel.make({}))
      return
    }
    exit()
  }

  useScopedKeyboard((event) => {
    // A keybind between two escapes is a different gesture, so it disarms the quit.
    if (command.handleKeybind(event, ext.commands())) {
      disarmQuit()
      return true
    }
    if (event.ctrl === true && event.name === "c") {
      handleInterrupt()
      return true
    }
    if (overlayHoldsComposer(uiState().overlay)) return false

    if (event.name === "escape") {
      if (uiState().transcriptExpanded && !command.paletteOpen()) {
        dispatchSessionUi(SessionUiEvent.cases.ToggleTranscript.make({}))
        disarmQuit()
        return true
      }
      if (command.paletteOpen()) {
        command.closePalette()
        disarmQuit()
        return true
      }
      if (uiState().disclosure !== "collapsed") {
        dispatchSessionUi(SessionUiEvent.cases.CollapseDisclosure.make({}))
        disarmQuit()
        return true
      }

      if (client.isStreaming()) {
        client.steer(SteerCommandInput.cases.Cancel.make({}))
        disarmQuit()
        return true
      }

      pressQuit(() => {
        if (interactionState().draft.length === 0) return
        onComposerInteraction(ComposerInteractionEvent.cases.ClearDraft.make({}))
      })
      return true
    }

    if (event.ctrl === true && event.name === "r") {
      promptSearch.open()
      disarmQuit()
      return true
    }

    if (handleTranscriptKey(event)) return true

    if (event.ctrl === true && event.shift === true && event.name === "m") {
      dispatchSessionUi(SessionUiEvent.cases.OpenMermaid.make({}))
      return true
    }

    return false
  })

  return {
    items,
    messages: feed.messages,
    forkMessages: () => {
      const overlay = uiState().overlay
      if (overlay._tag !== "fork") return []
      return overlay.messages
    },
    queueState,
    composerState,
    interactionState,
    saveDraft: (draft) => drafts.set(draftBranchId, draft),
    uiState,
    promptSearch,
    activity,
    phaseLabel,
    elapsed,
    onComposerInteraction,
    onSubmit,
    onSlashCommand,
    onRestoreQueue,
    dispatchComposer,
    resolveAuthGate,
    closeOverlay,
    onForkSelect,
    onModelSelect,
    onReasoningSelect,
    currentSessionName,
    onBranchPickerDismiss,
    onBranchPickerSelect,
  }
}

// ── Context ──

export const SessionControllerContext = createContext<SessionController>()

export function useSessionController(): SessionController {
  return useRequiredContext(
    SessionControllerContext,
    "useSessionController must be used within SessionControllerContext.Provider",
  )
}
