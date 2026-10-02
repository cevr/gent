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
  type Setter,
  untrack,
} from "solid-js"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Match,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import {
  type AgentEvent,
  ApprovalDecisionSchema,
  type ApprovalResult,
  assistantMessageIdForTurn,
  Branch,
  type BranchId,
  Message as DurableMessage,
  type AuthProviderInfo,
  type EventEnvelope,
  InteractionPresented,
  type MessageId,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
  Model,
  type ModelContextMetrics,
  type ModelId,
  modelInputCeilingTokens,
  projectMessage,
  ReasoningEffort,
  type SessionId,
  type GentClientRpcError,
  type MessageSegment,
  type ProjectedMessage,
  type QueueEntryInfo,
  type QueueSnapshot,
  type ToolInteraction,
} from "@gent/core/protocol"
import {
  formatConnectionIssue,
  extractUnknownMessage,
  formatError,
  formatTokens,
  type PathPlace,
  toolArgSummary,
  lostRequest,
  randomId,
  SEND_RETRY,
  useRequiredContext,
} from "./utils"
import type { RGBA } from "@opentui/core"
import {
  type ClientContextValue,
  type ClientLog,
  sameIdentity,
  type SessionIdentity,
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
  closedPromptSearch,
  transitionPromptSearch,
} from "./pickers"
import { useEnv, useWorkspace } from "./workspace"
import { writeFileAtomic } from "@gent/core/host"
import {
  clearFrecencyStore,
  type FrecencyLookup,
  noFrecency,
  rankAutocompleteItems,
  readFrecencyLookup,
  recordFrecencyPick,
} from "./autocomplete"
import { type Command, executeSlashCommand, isSlashCommandName, useCommand } from "./commands"
import { createStore, produce, type SetStoreFunction, unwrap } from "solid-js/store"
import {
  addStep,
  type AssistantSegment,
  currentMillis,
  emptyTurnSteps,
  leaveTerminal,
  isMessageItem,
  type Message,
  messageToolCalls,
  type RetryOutcome,
  type SessionEvent,
  type SessionItem,
} from "./message-list"
import type { ToolCall } from "./tool-renderers"
import { useRenderer } from "@opentui/solid"
import { type ScopedKeyboardEvent, useInputWatch, useScopedKeyboard } from "./terminal"
import { useExtensionUI } from "./extensions/host"
import type { ActiveExtensionSession, NoticeRow } from "./extensions/client-facets"
import type { ResolvedNoticeRows } from "./extensions/loader-boundary"

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

/**
 * `ctx 42%`: the messages' share of the input the projection lets them take.
 * Both numbers leave out the system prompt, the tools and the output
 * reserve, and the estimate is anchored on the last step's measured input,
 * so the gauge reads 100% where the window hands off, also on a model whose
 * input cap is below its window. What the projection dropped is in the
 * thread pane.
 */
const projectionLabel = (context: ModelContextMetrics, theme: ThemeColors): StatusRowLabel => {
  const pct = Math.min(
    100,
    Math.round((context.estimatedTokens / context.availableInputTokens) * 100),
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
  /** The session's model, for its catalog limits. */
  readonly model: Option.Option<Pick<Model, "contextLength" | "inputLimit" | "outputLimit">>
  readonly theme: ThemeColors
}): StatusRowLabel[] {
  const projection = input.metrics.context
  if (Option.isSome(projection) && projection.value.availableInputTokens > 0) {
    // The projection names the input the messages may take.
    return [projectionLabel(projection.value, input.theme)]
  }
  // No projection yet (a session from before projections): the provider's
  // count against the input one request may carry, the ceiling the turn's
  // budget uses, so the gauge reads full where the turn hands off.
  const tokens = input.metrics.latestInputTokens
  const limit = Option.flatMap(input.model, (model) =>
    Option.map(Option.fromUndefinedOr(model.contextLength), (window) =>
      modelInputCeilingTokens({
        contextLimitTokens: window,
        inputLimitTokens: Option.fromUndefinedOr(model.inputLimit),
        outputLimitTokens: Option.fromUndefinedOr(model.outputLimit),
      }),
    ),
  )
  if (tokens > 0 && Option.isSome(limit) && limit.value > 0) {
    const pct = Math.min(100, Math.round((tokens / limit.value) * 100))
    return [{ text: `${formatTokens(tokens)} (${pct}%)`, color: pressureColor(pct, input.theme) }]
  }
  return []
}

/**
 * The labels that sit beside the model name: its effort, and the debug mark.
 *
 * The context gauge is in {@link buildContextLabels}, in the row's
 * right-anchored group — effort names how the model is
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
  state: ComposerInteractionState,
  text: string,
  contributions: ReadonlyArray<AutocompleteContribution>,
): Option.Option<AutocompleteState> => {
  if (state.mode === "shell") return Option.none()

  const prefixes = contributions.map((c) => c.prefix)
  if (prefixes.length === 0) return Option.none()

  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  // The filter is a bare run (`@src/a`) or an open quote to the end
  // (`@"my dir/no`), which a quoted directory row leaves behind.
  const regex = new RegExp(`(?:^|[\\s])([${escaped.join("")}])("[^"]*|[^\\s]*)$`)
  return Option.fromNullishOr(regex.exec(text)).pipe(
    Option.flatMap((match) =>
      Option.all([Option.fromNullishOr(match[1]), Option.fromNullishOr(match[2])]),
    ),
    Option.flatMap(([prefix, typed]) => {
      if (prefix.length === 0) return Option.none()
      // The trigger ends the text, so it starts where the prefix and filter
      // do. Any whitespace before it (a space, a newline, a tab) stays.
      const triggerPos = text.length - prefix.length - typed.length
      let filter = typed
      if (typed.startsWith('"')) filter = typed.slice(1)

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
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      DraftChanged: ({ text }): ComposerInteractionState => ({
        ...state,
        draft: text,
        autocomplete: deriveAutocomplete(state, text, contributions),
      }),
      RestoreDraft: ({ text }): ComposerInteractionState => ({
        ...state,
        draft: text,
        autocomplete: Option.none(),
      }),
      ClearDraft: (): ComposerInteractionState => ({
        ...state,
        draft: "",
        autocomplete: Option.none(),
      }),
      EnterShell: (): ComposerInteractionState => ({
        ...state,
        mode: "shell",
        autocomplete: Option.none(),
      }),
      ExitShell: (): ComposerInteractionState => ({
        ...state,
        mode: "editing",
        autocomplete: Option.none(),
      }),
      CloseAutocomplete: (): ComposerInteractionState => ({
        ...state,
        autocomplete: Option.none(),
      }),
    }),
  )
}

// ── composer state ──────────────────────────────────────────────────────────

/**
 * Composer state — raw interaction events, no normalization.
 *
 * Shell mode, autocomplete, and history are local controller concerns.
 * This state handles server-driven interaction flows (questions, permissions, prompts, handoffs).
 */

export const ComposerState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("interaction", { interaction: InteractionPresented }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ComposerState = Schema.Schema.Type<typeof ComposerState>

export const ComposerEvent = Schema.TaggedUnion({
  EnterInteraction: { interaction: InteractionPresented },
  ResolveInteraction: { result: ApprovalDecisionSchema },
  DismissInteraction: { requestId: Schema.String },
})
export type ComposerEvent = Schema.Schema.Type<typeof ComposerEvent>

type ComposerEffect = {
  readonly _tag: "DispatchInteractionResult"
  readonly interaction: InteractionPresented
  readonly result: ApprovalResult
}

interface TransitionResult {
  readonly state: ComposerState
  readonly effect?: ComposerEffect
}

function transition(state: ComposerState, event: ComposerEvent): TransitionResult {
  return Match.value(event).pipe(
    Match.tagsExhaustive({
      EnterInteraction: ({ interaction }): TransitionResult => ({
        state: { _tag: "interaction", interaction },
      }),
      ResolveInteraction: ({ result }): TransitionResult => {
        if (state._tag !== "interaction") return { state }
        return {
          state: ComposerState.cases.idle.make({}),
          effect: {
            _tag: "DispatchInteractionResult",
            interaction: state.interaction,
            result,
          },
        }
      },
      // Only the interaction on screen is dismissed; a late dismissal of another is dropped.
      DismissInteraction: ({ requestId }): TransitionResult => {
        if (state._tag !== "interaction" || state.interaction.requestId !== requestId) {
          return { state }
        }
        return { state: ComposerState.cases.idle.make({}) }
      },
    }),
  )
}

// ── composer memory ─────────────────────────────────────────────────────────
//
// What the composer keeps across its own remounts: the draft per branch, the
// prompt history it navigates and the `-p` startup prompt. All live for one
// mounted shell, owned by this provider rather than by a module global.
//
// The startup prompt belongs to the session the startup flags named, on
// whichever branch of it the reader ends up: picking a branch in the boot
// picker re-mounts the session view, and the prompt has to survive that. A
// session the reader opens afterwards is a different session and starts
// empty, so the prompt is keyed on the boot session's id rather than handed to
// whoever asks first.

/**
 * The startup prompt as a submission. It is sent once; a send that fails is
 * refused as a composer submission is: it comes back to the draft of the
 * branch it was sent from, with its reason.
 */
interface StartupPrompt {
  readonly content: string
  /** `lost` is the request id when the reply was lost, not answered. */
  readonly refuse: (target: SessionIdentity, reason: string, lost: Option.Option<string>) => void
}

type ComposerDraft = Pick<ComposerInteractionState, "draft" | "mode">

interface ComposerDrafts {
  readonly get: (branchId: BranchId) => Option.Option<ComposerDraft>
  readonly set: (branchId: BranchId, draft: ComposerDraft) => void
}

/** A submission its session refused. `order` is its place among the branch's sends. */
interface RefusedSubmission {
  readonly order: number
  readonly text: string
  readonly shell: boolean
  /**
   * The request id of a send whose reply was lost: the server may have run it.
   * The same text sent again reuses it, so the server's dedup runs it once.
   * A refusal the server answered has none; its text goes again as new.
   */
  readonly requestId: Option.Option<string>
}

/** The composer on screen for a branch: what it holds, and how to replace it. */
interface ComposerLink {
  readonly current: () => ComposerDraft
  readonly apply: (draft: ComposerDraft) => void
  /** How this composer writes a refused text: a large one as a paste placeholder. */
  readonly write: (text: string) => string
}

/**
 * Refused submissions go back to the draft of the branch they were sent from:
 * into its composer when one is on screen, into its kept draft when not. None
 * is lost, and several come back in the order they were sent, ahead of what
 * the reader has typed since.
 */
interface ComposerRefusals {
  /** The next submission's place in send order. */
  readonly nextOrder: () => number
  readonly link: (branchId: BranchId, link: ComposerLink) => () => void
  readonly refuse: (branchId: BranchId, refused: RefusedSubmission, dismiss: () => void) => void
  /** Editing a restored draft dismisses its reason, including after a session switch. */
  readonly changed: (branchId: BranchId, draft: string) => void
  /**
   * A submit took the whole draft, refused texts included. When it sends one
   * refused text unchanged whose reply was lost, this is that send's request id.
   */
  readonly submitted: (branchId: BranchId, text: string) => Option.Option<string>
}

interface ComposerMemory {
  readonly drafts: ComposerDrafts
  readonly refusals: ComposerRefusals
  readonly history: PromptHistoryStore
  /**
   * Text taken back from a branch's queue replaces that branch's draft: in
   * its composer when one is on screen, in its kept draft when not. The drain
   * has committed by then, so the text must not depend on the view that asked.
   */
  readonly restore: (branchId: BranchId, text: string) => void
  /**
   * The `-p` prompt, if this is the session the startup flags named and no
   * one took it yet. A session view that mounts again gets nothing: the
   * prompt goes out once, and a failed send gives it to the draft.
   */
  readonly takePrompt: (sessionId: SessionId) => Option.Option<string>
}

interface ComposerMemoryProviderProps {
  readonly initialPrompt: Option.Option<string>
  /** The session the startup flags resolved to, if there was one. */
  readonly initialSessionId: Option.Option<SessionId>
}

/** A refused text and how it was written into the draft. */
interface WrittenRefusal extends RefusedSubmission {
  readonly written: string
}

/** The refused texts the draft starts with, as last written there. */
interface RefusedBlock {
  readonly entries: ReadonlyArray<WrittenRefusal>
  readonly shown: string
}

const EMPTY_REFUSED_BLOCK: RefusedBlock = { entries: [], shown: "" }
const REFUSED_SEPARATOR = "\n\n"

/**
 * Put a refused submission into a draft. While the draft still starts with
 * the refused texts written there before, the new one joins them in send
 * order; once the reader has edited them, it goes ahead of the whole draft.
 * A draft of shell commands only stays in shell mode; a mixed one is a
 * message, each command written with its `!`.
 *
 * `write` is how the draft holds a message: a composer on screen writes a
 * large one as a paste placeholder. A command is always written as text, so
 * the reader sees what Enter runs. A text a kept draft held as itself is
 * written again when its block joins a composer on screen.
 */
interface RefusedMerge {
  readonly draft: ComposerDraft
  readonly block: RefusedBlock
}

const writeAsIs = (text: string): string => text

export const mergeRefused = (
  current: ComposerDraft,
  block: RefusedBlock,
  refused: RefusedSubmission,
  write: (text: string) => string = writeAsIs,
): RefusedMerge => {
  const writeEntry = (entry: RefusedSubmission): string => {
    if (entry.shell) return entry.text
    return write(entry.text)
  }
  const rewrite = (entry: WrittenRefusal): WrittenRefusal => {
    if (entry.written !== entry.text) return entry
    return { ...entry, written: writeEntry(entry) }
  }
  const added: WrittenRefusal = { ...refused, written: writeEntry(refused) }
  // The block stands whole: the draft is it, or it and then a separator.
  const kept =
    block.shown.length > 0 &&
    (current.draft === block.shown ||
      current.draft.startsWith(`${block.shown}${REFUSED_SEPARATOR}`))
  let entries: ReadonlyArray<WrittenRefusal> = [added]
  let typed = current.draft
  if (kept) {
    entries = [...block.entries.map(rewrite), added].toSorted((a, b) => a.order - b.order)
    typed = current.draft.slice(block.shown.length + REFUSED_SEPARATOR.length)
  }
  const hasTyped = typed.trim().length > 0
  const allShell = entries.every((entry) => entry.shell) && (!hasTyped || current.mode === "shell")
  const render = (text: string, shell: boolean) => {
    if (shell && !allShell) return `!${text}`
    return text
  }
  const shown = entries.map((entry) => render(entry.written, entry.shell)).join(REFUSED_SEPARATOR)
  let draft = shown
  if (hasTyped) draft = `${shown}${REFUSED_SEPARATOR}${render(typed, current.mode === "shell")}`
  let mode: ComposerDraft["mode"] = "editing"
  if (allShell) mode = "shell"
  return { draft: { draft, mode }, block: { entries, shown } }
}

const ComposerMemoryContext = createContext<ComposerMemory>()

export function ComposerMemoryProvider(props: ParentProps<ComposerMemoryProviderProps>) {
  const byBranch = new Map<BranchId, ComposerDraft>()
  const drafts: ComposerDrafts = {
    get: (branchId) => Option.fromNullishOr(byBranch.get(branchId)),
    set: (branchId, draft) => {
      if (draft.draft.length === 0 && draft.mode === "editing") {
        byBranch.delete(branchId)
        return
      }
      byBranch.set(branchId, draft)
    },
  }
  const links = new Map<BranchId, ComposerLink>()
  const blocks = new Map<BranchId, RefusedBlock>()
  const standing = new Map<BranchId, { readonly draft: string; readonly dismiss: () => void }>()
  let sent = 0
  const refusals: ComposerRefusals = {
    nextOrder: () => sent++,
    link: (branchId, link) => {
      links.set(branchId, link)
      return () => {
        if (links.get(branchId) === link) links.delete(branchId)
      }
    },
    refuse: (branchId, refused, dismiss) => {
      const live = Option.fromUndefinedOr(links.get(branchId))
      const current = Option.match(live, {
        onSome: (link) => link.current(),
        onNone: () =>
          Option.getOrElse(drafts.get(branchId), (): ComposerDraft => ({
            draft: "",
            mode: "editing",
          })),
      })
      const merged = mergeRefused(
        current,
        Option.getOrElse(Option.fromUndefinedOr(blocks.get(branchId)), () => EMPTY_REFUSED_BLOCK),
        refused,
        // A kept draft is stored as text; only a composer on screen holds placeholders.
        Option.match(live, { onSome: (link) => link.write, onNone: () => writeAsIs }),
      )
      blocks.set(branchId, merged.block)
      Option.match(live, {
        onSome: (link) => link.apply(merged.draft),
        onNone: () => drafts.set(branchId, merged.draft),
      })
      standing.set(branchId, { draft: merged.draft.draft, dismiss })
    },
    changed: (branchId, draft) => {
      const refused = Option.fromUndefinedOr(standing.get(branchId))
      if (Option.isNone(refused) || refused.value.draft === draft) return
      standing.delete(branchId)
      refused.value.dismiss()
    },
    submitted: (branchId, text) => {
      const block = Option.fromUndefinedOr(blocks.get(branchId))
      blocks.delete(branchId)
      return Option.flatMap(block, (current) =>
        Option.flatMap(
          Option.fromUndefinedOr(current.entries.find((entry) => entry.text.trim() === text)),
          (entry) => entry.requestId,
        ),
      )
    },
  }
  let taken = false
  const takePrompt = (sessionId: SessionId): Option.Option<string> => {
    const owns = Option.exists(props.initialSessionId, (boot) => boot === sessionId)
    if (!owns || taken) return Option.none()
    return Option.map(props.initialPrompt, (content) => {
      taken = true
      return content
    })
  }
  const restore = (branchId: BranchId, text: string): void => {
    // Queued text is a message, so the draft is one too.
    const draft: ComposerDraft = { draft: text, mode: "editing" }
    const live = Option.fromUndefinedOr(links.get(branchId))
    if (Option.isSome(live)) {
      live.value.apply(draft)
      return
    }
    drafts.set(branchId, draft)
    // A composer on screen reports its own edit; a kept draft reports here.
    refusals.changed(branchId, text)
  }
  const value: ComposerMemory = {
    drafts,
    refusals,
    history: makePromptHistoryStore(),
    restore,
    takePrompt,
  }
  return (
    <ComposerMemoryContext.Provider value={value}>{props.children}</ComposerMemoryContext.Provider>
  )
}

const useComposerMemory = () =>
  useRequiredContext(ComposerMemoryContext, "The composer requires ComposerMemoryProvider")

export const useComposerRefusals = () => useComposerMemory().refusals

const useComposerDrafts = () => useComposerMemory().drafts

// ── session UI state ────────────────────────────────────────────────────────

const SessionOverlayState = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("fork", { messages: Schema.Array(DurableMessage) }),
  Schema.TaggedStruct("auth", { enforceAuth: Schema.Boolean }),
  Schema.TaggedStruct("model", {}),
  Schema.TaggedStruct("reasoning", {}),
  /**
   * The branch picker. The boot flow is the only thing that opens it, so
   * escape does nothing: a reader who never chose a branch has nowhere to
   * fall back to, and ctrl+c still quits.
   */
  Schema.TaggedStruct("branches", { branches: Schema.Array(Branch) }),
  /** The palette owns its own state; the overlay carries it rather than copying its fields. */
  Schema.TaggedStruct("prompt-search", { state: PromptSearchState }),
  /**
   * A client extension's docked pane, by the name the extension gave it. It
   * shares this union so one pane or picker is open at a time; unlike the
   * session's own overlays it leaves the composer focused and its keys live.
   */
  Schema.TaggedStruct("pane", { id: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
type SessionOverlayState = Schema.Schema.Type<typeof SessionOverlayState>

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
      onNone: (): SessionOverlayState => SessionOverlayState.cases.none.make({}),
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

/**
 * Events that put something in the one slot. The boot branch picker and an
 * enforced sign-in hold the slot until they close: the startup prompt and the
 * auth gate wait on them, so a pane opened over them would let the prompt
 * send into a branch the reader never chose.
 */
const SLOT_OPENERS: ReadonlySet<SessionUiEvent["_tag"]> = new Set([
  "OpenFork",
  "OpenAuth",
  "OpenSettingsPicker",
  "OpenBranches",
  "OpenPane",
  "PromptSearch",
])

const slotHeld = (overlay: SessionOverlayState): boolean =>
  overlay._tag === "branches" || (overlay._tag === "auth" && overlay.enforceAuth)

/** Only a preview reaches the composer; the palette closes through the overlay. */
const composerEffects = (
  effects: ReturnType<typeof transitionPromptSearch>["effects"],
): readonly SessionUiEffect[] =>
  effects
    .filter((effect) => effect._tag === "Preview")
    .map((effect): SessionUiEffect => ({ _tag: "RestoreComposer", text: effect.text }))

/**
 * What an overlay leaves behind when something else takes its slot: its own
 * cancel. Prompt search gives the composer back the draft it opened over; the
 * other overlays hold nothing outside the slot.
 */
const cancelOverlay = (overlay: SessionOverlayState): readonly SessionUiEffect[] => {
  if (overlay._tag !== "prompt-search") return []
  return composerEffects(
    transitionPromptSearch(overlay.state, PromptSearchEventSchema.cases.Cancel.make({})).effects,
  )
}

export function transitionSessionUi(
  state: SessionUiState,
  event: SessionUiEvent,
): SessionUiTransitionResult {
  if (slotHeld(state.overlay) && SLOT_OPENERS.has(event._tag)) return { state, effects: [] }
  const result = transitionSlot(state, event)
  // Prompt search events move their own overlay; any other event that takes
  // the slot from an overlay runs that overlay's cancel first.
  if (event._tag === "PromptSearch" || result.state.overlay === state.overlay) return result
  return { state: result.state, effects: [...cancelOverlay(state.overlay), ...result.effects] }
}

function transitionSlot(state: SessionUiState, event: SessionUiEvent): SessionUiTransitionResult {
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
        // A late event from a palette that lost the slot (its list's cleanup,
        // say) acts on nothing: the overlay in the slot now is not its own.
        if (state.overlay._tag !== "prompt-search" && event.event._tag !== "Open") {
          return { state, effects: [] }
        }
        let promptState = closedPromptSearch()
        if (state.overlay._tag === "prompt-search") promptState = state.overlay.state
        const result = transitionPromptSearch(promptState, event.event)
        const effects = composerEffects(result.effects)
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
  /** The agent the last auth check answered for; None before one answers. */
  readonly validatedAgent: Option.Option<string>
  readonly authCheckVersion: number
  readonly queue: QueueState
  readonly elapsed: number
}

const emptyQueueState = (): QueueState => ({ steering: [], followUp: [] })

/**
 * The gate starts closed with no agent checked: the session's first auth check
 * runs at mount and holds the startup prompt until it answers for the agent.
 */
export const initialSessionControllerState = (): SessionControllerState => ({
  authGate: "closed",
  validatedAgent: Option.none(),
  authCheckVersion: 0,
  queue: emptyQueueState(),
  elapsed: 0,
})

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
  return { ...state, validatedAgent: Option.some(input.agent), authGate }
}

export const failAuthCheck = (
  state: SessionControllerState,
  version: number,
): SessionControllerState => {
  if (version !== state.authCheckVersion) return state
  return {
    ...state,
    validatedAgent: Option.none(),
    authGate: "error",
  }
}

export const closeAuthGateState = (
  state: SessionControllerState,
  agent: Option.Option<string>,
): SessionControllerState => ({
  ...state,
  authCheckVersion: state.authCheckVersion + 1,
  validatedAgent: agent,
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

/** The queued prompts as one draft; none when the queue is empty. */
export const queuedDraftText = (queue: QueueState): Option.Option<string> => {
  const all = [...queue.steering, ...queue.followUp]
  if (all.length === 0) return Option.none()
  return Option.some(all.map((entry) => entry.content).join("\n"))
}

const isBlockingAuthGate = (state: AuthGateState): boolean => state === "open" || state === "error"

// ── prompt history ──────────────────────────────────────────────────────────

/**
 * Prompt history — navigate previous prompts with up/down arrows.
 *
 * Plain text entries, persisted to ~/.cache/gent/prompt-history.json.
 * Max 100 entries. Deduplicates against the last entry on add.
 *
 * Every `gent` sharing a home writes the same file. An add re-reads it and
 * folds the prompt into what is on disk, so a second TUI's prompts survive
 * this one's next submit, and the write is atomic, so a crash leaves the old
 * list or the new one, never truncated JSON that reads as empty.
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
    yield* writeFileAtomic(paths.file, encodeHistoryStore(HistoryStore.make({ entries: items })))
  }).pipe(Effect.ignoreCause)

/** The list after `prompt` is added: newest first, capped, no repeat of the newest. */
const foldPrompt = (entries: ReadonlyArray<string>, prompt: string): string[] => {
  if (entries[0] === prompt) return [...entries]
  return [prompt, ...entries].slice(0, MAX_ENTRIES)
}

/**
 * Serializes the read-fold-write in `recordPrompt`. It guards a path on disk,
 * not a value one caller owns, so it is a module singleton — the same shape
 * as the frecency store's gate.
 */
const historyGate = Semaphore.makeUnsafe(1)

/**
 * Adds a prompt to the file on disk and answers the merged list. Entries
 * another `gent` wrote since this one loaded are kept.
 */
export const recordPrompt = (home: string, prompt: string) =>
  Effect.gen(function* () {
    const onDisk = Option.getOrElse(yield* readEntries(home), (): ReadonlyArray<string> => [])
    const next = foldPrompt(onDisk, prompt)
    yield* writeEntries(home, next)
    return next
  }).pipe(historyGate.withPermits(1))

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
  entries: Accessor<string[]>
  setEntries: Setter<string[]>
  historyIndex: number
  savedEntry: Option.Option<string>
  loaded: boolean
  /** Counts the adds; only the newest add's write sets the merged list. */
  adds: number
}

function makePromptHistoryStore(): PromptHistoryStore {
  const [entries, setEntries] = createSignal<string[]>([])
  return {
    entries,
    setEntries,
    historyIndex: -1,
    savedEntry: Option.none(),
    loaded: false,
    adds: 0,
  }
}

export function usePromptHistory(): PromptHistory {
  const store = useComposerMemory().history
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

  ensureLoaded()

  return {
    entries: () => store.entries(),

    add(text: string) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return

      // The local fold answers the next up-arrow at once; the merged list
      // from disk replaces it when the write lands. The writes run in order,
      // so the newest add's write holds every prompt; an older one that lands
      // after a newer add would drop that add, and is not applied.
      store.setEntries((prev) => foldPrompt(prev, trimmed))
      store.adds += 1
      const add = store.adds
      cast(
        recordPrompt(workspace.home, trimmed).pipe(
          Effect.tap((merged) =>
            Effect.sync(() => {
              if (add === store.adds) store.setEntries(merged)
            }),
          ),
        ),
      )
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
 * The pick history behind the composer's autocomplete ranking.
 *
 * One file serves every prefix and every session. Two surfaces record picks
 * into it — this hook for `/` commands, and the `$` skills extension — so the
 * hook keeps no store of its own: a copy owned by one surface goes stale the
 * moment the other writes.
 *
 * `lookup` reads the file each time ranking runs (`readFrecencyLookup`), so a
 * pick recorded anywhere ranks on the next keystroke. A missing or unreadable
 * file answers zero for every row, as a reader with no history gets: the
 * popup ranks by match quality.
 *
 * Every write goes through `recordFrecencyPick`, which folds the pick into
 * what is on disk under a single-permit gate. `cast` forks the write onto the
 * client runtime, so it never blocks the keystroke path.
 */

interface AutocompleteFrecency {
  /** The reader's decayed pick weights, read from the store when ranking runs. */
  readonly lookup: Effect.Effect<FrecencyLookup, never, FileSystem.FileSystem | Path.Path>
  /** Records that the reader chose `id` from the `prefix` popup. */
  readonly record: (prefix: string, id: string) => void
  /** Forgets every recorded pick, so ranking falls back to match quality alone. */
  readonly reset: () => void
}

function useAutocompleteFrecency(): AutocompleteFrecency {
  const workspace = useWorkspace()
  const { cast } = useRuntime()
  return {
    lookup: readFrecencyLookup(workspace.home),
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
  readonly frecency: Effect.Effect<FrecencyLookup, never, FileSystem.FileSystem | Path.Path>
  /** Records that the reader chose a command from the `/` popup. */
  readonly recordPick: (id: string) => void
  /** Forgets every recorded pick, so ranking starts over. */
  readonly resetFrecency: () => void
  readonly openForkPicker: () => void
  readonly openModelPicker: () => void
  readonly openReasoningPicker: () => void
  readonly openAuth: () => void
  /** Opens the palette: every command and its key. */
  readonly openPalette: () => void
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
 * The list is built unfiltered — names and aliases both — and
 * {@link rankAutocompleteItems} decides what matches and in what order. The
 * popup preselects its first row, so a title match must not count for as much
 * as a name match: `/ag` leads with `/agents`, not `/fork` ("Fork from
 * Mess**ag**e"). It
 * scores names far above descriptions, so a command whose description happens
 * to carry the letters still appears, but never ahead of the one actually
 * named.
 *
 * `frecency` carries the reader's own pick history. Without it `/t` answers
 * `think` forever, because `think` and `thread` tie on everything but length;
 * with it, the one this reader actually opens wins. It defaults to "no
 * history", so a caller that has not loaded a store ranks on the match alone.
 */
export const slashAutocompleteItems = (
  commands: readonly Command[],
  filter: string,
  frecency: FrecencyLookup = noFrecency,
): ReadonlyArray<AutocompleteItem> => {
  const items: Array<AutocompleteItem> = []
  // The command each name runs: an alias reaches its command, but the popup
  // shows one row per command, its best-ranked name (`/new` until `/cl` is typed).
  const owner = new Map<string, Command>()
  for (const command of commands) {
    const slash = Option.fromNullishOr(command.slash)
    if (Option.isNone(slash)) continue
    const description = command.description ?? command.title
    for (const name of [slash.value, ...(command.aliases ?? [])]) {
      items.push({ id: name, label: `/${name}`, description })
      owner.set(name, command)
    }
  }
  const shown = new Set<Command>()
  return rankAutocompleteItems(items, filter, { prefix: "/", frecency }).filter((item) =>
    Option.match(Option.fromUndefinedOr(owner.get(item.id)), {
      onNone: () => true,
      onSome: (command) => {
        if (shown.has(command)) return false
        shown.add(command)
        return true
      },
    }),
  )
}

const createSessionBuiltins = (props: SessionCommandRegistryProps): Command[] => [
  {
    // The usual way to look for commands: it opens the one list of them.
    id: "session.help",
    title: "Show Commands",
    category: "Session",
    slash: "help",
    onSelect: props.openPalette,
  },
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
    description: "Forget which commands and skills you pick most",
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
      props.cast(props.client.surfaceError(props.client.createBranch))
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
      const sessionReasoningLevel = Schema.decodeUnknownOption(ReasoningEffort)(
        reasoningLevel.value,
      )
      props.cast(props.client.updateSessionSettings({ reasoningLevel: sessionReasoningLevel }))
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
        props.cast(props.client.updateSessionSettings({ modelId }))
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
        items: (filter) =>
          Effect.map(props.frecency, (lookup) =>
            slashAutocompleteItems(allCommands, filter, lookup),
          ),
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
 * It reads neither client.session() nor machine state, so a settings or name
 * change on the session record never opens it again.
 */

interface ReconnectOptions<E> {
  readonly label?: string
  readonly log: ClientLog
  readonly onError?: (error: E) => void
  readonly waitForRetry: () => Effect.Effect<void>
}

const reconnectBase = Duration.seconds(1)

const reconnectBackoff = Schedule.min([
  Schedule.exponential(reconnectBase, 2),
  Schedule.spaced("30 seconds"),
])

/**
 * Runs a stream and runs it again whenever it ends. `effectFactory` gets the
 * `ready` effect and runs it once its stream has delivered, not when it
 * opens: a stream that fails before it delivers has not served.
 *
 * Attempts that end before they serve back off from one second up to thirty.
 * A stream that served starts a fresh sequence when it drops: after a long
 * healthy connection the next attempt comes a second later, not at the cap.
 */
export const runWithReconnect = <E, R>(
  effectFactory: (ready: Effect.Effect<void>) => Effect.Effect<void, E, R>,
  options: ReconnectOptions<E>,
): Effect.Effect<never, never, R> => {
  let attempt = 0
  const label = Option.getOrElse(Option.fromNullishOr(options.label), () => "unknown")
  const log = options.log
  const attemptOnce = Effect.gen(function* () {
    attempt++
    let served = false
    log.info("reconnect.attempt", { label, attempt })
    const ready = Effect.sync(() => {
      served = true
    })
    yield* effectFactory(ready).pipe(
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
    return served
  })
  // One connection: attempts back off until one serves and then ends.
  const connection = attemptOnce.pipe(
    Effect.repeat({ schedule: reconnectBackoff, until: (served) => served }),
  )
  return connection.pipe(Effect.andThen(Effect.sleep(reconnectBase)), Effect.forever)
}

// ── Types ──

interface SessionFeedCallbacks {
  onInteraction: (interaction: InteractionPresented) => void
  onInteractionDismissed: (requestId: string) => void
  onBranchSwitch: (sessionId: SessionId, branchId: BranchId) => void
  onQueueSnapshot: (queue: QueueSnapshot) => void
}

type ToolResultEvent = Extract<AgentEvent, { _tag: "ToolCallSucceeded" | "ToolCallFailed" }>

interface SessionFeed {
  items: () => SessionItem[]
  messages: () => Message[]
  /** The label of the tool that runs now; none between tools. */
  activeTool: () => Option.Option<string>
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
  | "finishReplay"
  | "resetSessionEvents"
  | "pathPlace"
>

type SessionFeedStore = {
  messages: Message[]
  events: SessionEvent[]
}

/** Transcript order: by time; a message before an event row at the same time; event rows by seq. */
const compareSessionItems = (a: SessionItem, b: SessionItem): number => {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  if (!isMessageItem(a) && !isMessageItem(b)) return a.seq - b.seq
  if (a._tag === b._tag) return 0
  if (isMessageItem(a)) return -1
  return 1
}

interface NoticeRowItems {
  readonly items: ReadonlyMap<NoticeRow, SessionItem>
  /** The sources still deriving; native history holds for each until its bound. */
  readonly pending: ReadonlyArray<ResolvedNoticeRows>
}

/**
 * How long native history holds for a notice-row source still deriving for a
 * branch once the client extensions loaded. After it, history commits without
 * that source's rows; the source stays, and an answer that comes later draws
 * its rows below whatever history already committed.
 */
export const NOTICE_ROWS_BOUND = Duration.seconds(5)

/**
 * The client extensions' notice rows for one branch, merged into the feed's
 * rows. Each row keeps its transcript item while the extension answers the
 * same row object, so the transcript does not remount rows that did not change.
 */
export const noticeRowItems = (
  sources: ReadonlyArray<ResolvedNoticeRows>,
  session: ActiveExtensionSession,
  previous: ReadonlyMap<NoticeRow, SessionItem>,
): NoticeRowItems => {
  const next = new Map<NoticeRow, SessionItem>()
  const pending: Array<ResolvedNoticeRows> = []
  for (const source of sources) {
    const rows = source.rows(session)
    if (Option.isNone(rows)) pending.push(source)
    for (const row of Option.getOrElse(rows, () => [])) {
      next.set(
        row,
        previous.get(row) ?? {
          _tag: "notice",
          key: `${source.id}:${row.key}`,
          glyph: row.glyph,
          color: row.color,
          text: row.text,
          createdAt: row.createdAt,
          seq: 0,
        },
      )
    }
  }
  return { items: next, pending }
}

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

const buildMessages = (msgs: readonly ProjectedMessage[]): Message[] =>
  msgs.flatMap((m) => {
    if (m.role === "tool") return []
    return [buildMessage(m, m.toolInteractions.map(toToolCall))]
  })

/**
 * One feed message from a projected one. Its tool-call segments draw the
 * `toolCalls` they name; a segment that names no call draws nothing.
 */
const buildMessage = (m: ProjectedMessage, toolCalls: ReadonlyArray<ToolCall>): Message => {
  // Only an assistant message calls tools, and its segments name every call it made.
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
    segments: Option.getOrUndefined(segments),
    metadata: m.metadata,
  }
}

/**
 * A received message takes its row, or replaces the row its id names. The
 * replaced row's tool calls stay: the feed attached them live, and their
 * status is newer than the received message's. The message itself carries
 * none: the feed projects it with no tool results (`projectMessage(m, [])`).
 */
const upsertReceivedMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  message: ProjectedMessage,
) => {
  if (message.role === "tool") return
  setStore(
    produce((draft) => {
      const index = draft.messages.findIndex((candidate) => candidate.id === message.id)
      const existing = Option.fromNullishOr(draft.messages[index])
      if (Option.isNone(existing)) {
        draft.messages.push(buildMessage(message, []))
        return
      }
      draft.messages[index] = buildMessage(message, messageToolCalls(existing.value))
    }),
  )
}

/** Give every retry row still in one of the `from` outcomes the outcome the feed just learned. */
const settleRetryingEvents = (
  setStore: SetStoreFunction<SessionFeedStore>,
  outcome: RetryOutcome,
  from: ReadonlyArray<RetryOutcome> = ["pending"],
) => {
  setStore(
    produce((draft) => {
      for (const event of draft.events) {
        if (event._tag === "retrying" && from.includes(event.outcome)) event.outcome = outcome
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
        segments: [{ _tag: "text", content }],
        draft: true,
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
  calls: ReadonlyArray<ToolCall>,
  toolCallId: string,
): Option.Option<ToolCall> => {
  for (const call of calls) {
    if (call.id === toolCallId) return Option.some(call)
    const nested = locateToolCall(
      Option.getOrElse(Option.fromNullishOr(call.operations), (): ToolCall[] => []),
      toolCallId,
    )
    if (Option.isSome(nested)) return nested
  }
  return Option.none()
}

/** Attach a cell-admitted call under its parent instead of the transcript top level. */
const attachOperation = (
  calls: ReadonlyArray<ToolCall>,
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
  // A snapshot's cuts describe the output it came with, not this one.
  delete call.value.cuts
  // An op still running when its cell ends ended with the cell, as a reload
  // projects it (`settledOperations` in core): it failed.
  for (const operation of call.value.operations ?? []) {
    if (operation.status === "running") operation.status = "error"
  }
  if (Predicate.isNotUndefined(call.value.startedAt)) {
    call.value.durationMs = Math.max(0, completedAt - call.value.startedAt)
  }
}

const handleToolCallResult = (
  setStore: SetStoreFunction<SessionFeedStore>,
  setRunningCalls: Setter<ReadonlyArray<RunningCall>>,
  toolEvent: ToolResultEvent,
  completedAt: number,
) => {
  let status: "error" | "completed" = "completed"
  if (toolEvent._tag === "ToolCallFailed") status = "error"

  setRunningCalls((calls) => endCall(calls, toolEvent.toolCallId))
  updateToolMessage(
    setStore,
    (message) =>
      applyToolCallResult(
        locateToolCall(messageToolCalls(message), toolEvent.toolCallId),
        status,
        toolEvent,
        completedAt,
      ),
    (message) => Option.isSome(locateToolCall(messageToolCalls(message), toolEvent.toolCallId)),
  )
}

const toActiveInteraction = (event: AgentEvent): Option.Option<InteractionPresented> => {
  if (event._tag === "InteractionPresented") return Option.some(event)
  return Option.none()
}

/**
 * Events whose effect the session snapshot already carries. Replay skips them
 * so a reload does not re-append settled tool payloads. A replayed chunk is
 * the answer in progress's to decide (`useSessionFeed`).
 */
const isSnapshotHeldEvent = Predicate.or(
  Predicate.isTagged("ToolCallStarted"),
  Predicate.or(Predicate.isTagged("ToolCallSucceeded"), Predicate.isTagged("ToolCallFailed")),
)

const isToolResultEvent = Predicate.or(
  Predicate.isTagged("ToolCallSucceeded"),
  Predicate.isTagged("ToolCallFailed"),
)

type ToolStartedEvent = Extract<AgentEvent, { _tag: "ToolCallStarted" }>

/** The status-line label for a running tool: its name plus a short input. */
const activeToolLabel = (event: ToolStartedEvent, place: PathPlace): string => {
  const inputSummary = toolArgSummary(event.toolName, event.input, place)
  if (inputSummary.length === 0) return event.toolName
  return `${event.toolName}(${inputSummary})`
}

/** A call that started and has no result yet; an op names the cell that admitted it. */
interface RunningCall {
  readonly id: string
  readonly parent: Option.Option<string>
  readonly label: string
}

/** A started call joins the running set once: a cold interaction resume starts it again. */
const startCall = (
  calls: ReadonlyArray<RunningCall>,
  event: ToolStartedEvent,
  place: PathPlace,
): ReadonlyArray<RunningCall> => {
  if (calls.some((call) => call.id === event.toolCallId)) return calls
  return [
    ...calls,
    {
      id: event.toolCallId,
      parent: Option.fromUndefinedOr(event.parentToolCallId),
      label: activeToolLabel(event, place),
    },
  ]
}

/** A result ends its call, and a cell's result ends the ops it admitted. */
const endCall = (calls: ReadonlyArray<RunningCall>, id: string): ReadonlyArray<RunningCall> =>
  calls.filter((call) => call.id !== id && !Option.contains(call.parent, id))

/**
 * The status-line label: every running call that is not waiting on an op of
 * its own, so a cell's sibling ops show side by side, the one that asks and
 * the one that runs on.
 */
const runningLabel = (calls: ReadonlyArray<RunningCall>): Option.Option<string> => {
  const leaves = calls.filter(
    (call) => !calls.some((other) => Option.contains(other.parent, call.id)),
  )
  if (leaves.length === 0) return Option.none()
  return Option.some(leaves.map((call) => call.label).join(" · "))
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
    startedAt,
  } satisfies ToolCall
  const parentToolCallId = Option.fromUndefinedOr(event.parentToolCallId)
  updateToolMessage(
    setStore,
    (message) => {
      if (Option.isSome(parentToolCallId)) {
        attachOperation(messageToolCalls(message), parentToolCallId.value, toolCall)
        return
      }
      // Cold interaction resume starts the same call again, not a new call.
      if (messageToolCalls(message).some((call) => call.id === event.toolCallId)) return
      if (Option.isNone(Option.fromNullishOr(message.segments))) message.segments = []
      message.segments?.push({ _tag: "tool-call", toolCall })
    },
    (message) => {
      if (Option.isSome(parentToolCallId)) {
        return Option.isSome(locateToolCall(messageToolCalls(message), parentToolCallId.value))
      }
      // A late receipt names the message it belongs to; it must not land on a newer one.
      if (Predicate.isNotUndefined(event.assistantMessageId))
        return message.id === event.assistantMessageId
      return true
    },
  )
}

// ── Hook ──

export function useSessionFeed(
  sessionId: SessionId,
  branchId: BranchId,
  client: SessionFeedClient,
  callbacks: SessionFeedCallbacks,
  /** Read at send time, so the owner decides whether the prompt is still unsent. */
  takeInitialPrompt: () => Option.Option<StartupPrompt>,
  /** False while sign-in or the branch picker holds the startup prompt back. */
  canSendPrompt: () => boolean,
): SessionFeed {
  const [store, setStore] = createStore<{ messages: Message[]; events: SessionEvent[] }>({
    messages: [],
    events: [],
  })
  const [runningCalls, setRunningCalls] = createSignal<ReadonlyArray<RunningCall>>([])
  const [streamReady, setStreamReady] = createSignal(false)
  // The answer the step in flight streams into: the one row drawn as streaming.
  const [openAnswer, setOpenAnswer] = createSignal(Option.none<string>(), {
    equals: Option.makeEquivalence<string>((left, right) => left === right),
  })
  // When the open answer's request went out: its row, drawn with the first chunk, sorts there.
  let answerStartedAt = 0
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
        // A live answer is the step's stored answer: it replaces the streamed text.
        if (isStandaloneMessage(event.message) || live) {
          upsertReceivedMessage(setStore, projectMessage(event.message, []))
        }
        return

      case "StreamEnded":
        setOpenAnswer(Option.none())
        // A cut stream ends a retry that had not answered; a settled one means it ran.
        if (event.interrupted === true) settleRetryingEvents(setStore, "cancelled")
        else settleRetryingEvents(setStore, "retried")
        turnSteps = addStep(turnSteps, event)
        return

      case "TurnCompleted":
        setOpenAnswer(Option.none())
        // A cancel ends a retry that had not answered; any other end means it ran.
        if (event.interrupted === true)
          settleRetryingEvents(setStore, "cancelled", ["pending", "stopped"])
        else settleRetryingEvents(setStore, "retried", ["pending", "stopped"])
        appendTurnEndRow(event, stampedAt)
        return

      case "ToolCallStarted":
        setRunningCalls((calls) => startCall(calls, event, client.pathPlace()))
        startToolCall(setStore, event, receivedAt)
        return

      case "ProviderRetrying":
        // A new retry means the one before it ran and failed again.
        settleRetryingEvents(setStore, "retried")
        appendSessionEvent(setStore, {
          _tag: "retrying",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          outcome: "pending",
          reason: event.error,
          createdAt: stampedAt,
          seq: eventSeq++,
        })
        // The retry's request goes out `delayMs` after its row; an answer not
        // yet drawn dates from then, so the row sits above it. Core's own
        // clock readers date the request the same way (`knownRequestStart`).
        answerStartedAt = stampedAt + event.delayMs
        return

      case "ErrorOccurred":
        // A notice leaves the turn running: a muted row, no retry settled.
        if (event.notice === true) {
          if (live) client.log.warn("sessionFeed.notice", { error: event.error, seq: eventSeq })
          const seq = eventSeq++
          appendSessionEvent(setStore, {
            _tag: "notice",
            key: `error:${stampedAt}:${seq}`,
            glyph: "●",
            color: "textMuted",
            text: event.error,
            createdAt: stampedAt,
            seq,
          })
          return
        }
        // The retry ran and failed; the error row says how the turn ended.
        settleRetryingEvents(setStore, "retried")
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

  // ── the answer in progress ──
  //
  // Core publishes each chunk as a stored event and stores the step's answer
  // (its `MessageReceived`) only when the step ends. So the answer in
  // progress is built from chunks, stored and live alike: a `StreamStarted`
  // opens it, its first content (a chunk, or a tool call) draws its row, each
  // later chunk extends it, and the step's live `MessageReceived` replaces it
  // with the stored answer (`applySettledEvent`). A step whose answer the
  // snapshot holds is settled: its replayed chunks add nothing.

  /** The ids of the answers the latest snapshot holds. */
  let snapshotAnswers: ReadonlySet<string> = new Set()

  /**
   * Take a snapshot. It holds settled answers only, so the answer in
   * progress stays on top of it unless the snapshot already holds its id.
   */
  const applySnapshotMessages = (messages: ReadonlyArray<ProjectedMessage>) => {
    snapshotAnswers = new Set(messages.map((message) => String(message.id)))
    const next = buildMessages(messages)
    setOpenAnswer(Option.filter(openAnswer(), (id) => !snapshotAnswers.has(id)))
    const inProgress = Option.flatMap(openAnswer(), (id) =>
      Option.fromNullishOr(store.messages.find((message) => message.id === id)),
    )
    if (Option.isSome(inProgress)) next.push(unwrap(inProgress.value))
    setStore("messages", next)
  }

  /**
   * Open the answer this step streams into. The durable input id and step
   * name it, so a later chunk or receipt finds the same owner. A replayed
   * start opens only an answer the snapshot does not hold; one with no input
   * id cannot say, so it opens nothing. Opening draws nothing: the row comes
   * with the first chunk, so a step that streamed nothing (a provider that
   * failed first, a cancel during the backoff) draws no answer, live or on
   * a reload.
   */
  const openStreamedAnswer = (
    event: Extract<AgentEvent, { _tag: "StreamStarted" }>,
    stampedAt: number,
    live: boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const durable = Option.map(Option.fromUndefinedOr(event.messageId), (inputId) =>
        String(assistantMessageIdForTurn(inputId, event.step)),
      )
      answerStartedAt = stampedAt
      if (!live) {
        setOpenAnswer(Option.filter(durable, (id) => !snapshotAnswers.has(id)))
        return
      }
      const id = yield* Option.match(durable, { onNone: () => randomId, onSome: Effect.succeed })
      setOpenAnswer(Option.some(id))
    })

  /**
   * A chunk extends the open answer; the first one draws its row, dated when
   * the answer's request went out. A replayed chunk with no open answer
   * belongs to a settled step; a live one opens a local answer (a history
   * stream with no start).
   */
  const appendStreamedChunk = (
    chunk: string,
    stampedAt: number,
    live: boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const open = openAnswer()
      if (!live && Option.isNone(open)) return
      if (Option.isNone(open)) answerStartedAt = stampedAt
      const id = yield* Option.match(open, {
        onNone: () => randomId,
        onSome: Effect.succeed,
      })
      setOpenAnswer(Option.some(id))
      ensureAssistantMessage(setStore, chunk, id, answerStartedAt)
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
  // The session view mounts keyed on the identity (app.tsx), so one feed
  // serves one session and branch for its whole life: a switch remounts it,
  // and the cleanup interrupts this feed's fiber. The cursor carries a
  // reconnect's replay on from where the last attempt stopped.
  let lastSeenEventId = 0
  const processedEnvelopeIds = new Set<EventEnvelope["id"]>()

  // The events the client held for the session before this one are not this feed's.
  client.resetSessionEvents()

  const items = createMemo((): SessionItem[] =>
    [...store.messages, ...store.events].sort(compareSessionItems),
  )

  const feedKey = `${sessionId}:${branchId}`

  // The client names the session in view. It moves first on a switch; the
  // feed stops then, before the view that holds it unmounts.
  const activeSessionKey = createMemo(
    () => `${client.sessionIdentity().sessionId}:${client.sessionIdentity().branchId}`,
  )

  createEffect(
    on([activeSessionKey, streamReady, canSendPrompt], ([active, ready, canSend]) => {
      if (active !== feedKey) return
      if (!ready || !canSend) return
      const startup = takeInitialPrompt()
      if (Option.isNone(startup)) return
      const prompt = startup.value
      if (prompt.content === "") return

      const session = sessionId
      const branch = branchId
      client.log.info("feed.sendInitialPrompt", {
        sessionId: session,
        branchId: branch,
      })
      client.runtime.cast(
        Effect.gen(function* () {
          const requestId = yield* randomId
          yield* client.client.message
            .send({ sessionId: session, branchId: branch, content: prompt.content, requestId })
            .pipe(
              // A lost connection retries under the one request id; after
              // the last try the prompt is refused like a composer send.
              Effect.retry(SEND_RETRY),
              Effect.catchEager((err) =>
                Effect.sync(() =>
                  prompt.refuse(
                    { sessionId: session, branchId: branch },
                    formatError(err),
                    lostRequest(err, requestId),
                  ),
                ),
              ),
            )
        }),
      )
    }),
  )

  createEffect(
    on(activeSessionKey, (active) => {
      if (active !== feedKey) return

      const key = feedKey
      const branch = branchId
      const session = sessionId
      client.log.info("feed.activate", { key })

      const streamFiber = client.runtime.fork(
        runWithReconnect(
          (ready) =>
            Effect.gen(function* () {
              client.log.info("feed.snapshot.fetch", { key })
              const snapshot = yield* client.client.session.getSnapshot({
                sessionId: session,
                branchId: branch,
              })
              // Pending interactions hydrate on session entry from
              // event-stream replay via the `after` cursor below.

              client.log.info("feed.snapshot.hydrated", {
                key,
                messageCount: snapshot.messages.length,
                lastEventId: snapshot.lastEventId,
              })

              yield* Effect.sync(() => {
                client.applySessionSnapshot(snapshot)
                callbacks.onQueueSnapshot(snapshot.runtime.queue)
                applySnapshotMessages(snapshot.messages)
              })

              const after = lastSeenEventId

              const eventStream = client.client.session.events({
                sessionId: session,
                branchId: branch,
                after,
              })

              // The attempt served once both streams delivered: the events
              // stream its replay (the `StreamSynchronized` marker), the
              // runtime watch its current state (the server's watch emits
              // it first). A stream that fails before that backs off.
              const eventsServed = yield* Deferred.make<void>()
              const runtimeServed = yield* Deferred.make<void>()
              yield* Effect.all([Deferred.await(eventsServed), Deferred.await(runtimeServed)]).pipe(
                Effect.andThen(ready),
                Effect.forkScoped,
              )

              client.log.info("feed.stream.open", { key, after })
              const eventsFiber = yield* eventStream.pipe(
                Stream.runForEach((envelope) =>
                  Effect.gen(function* () {
                    if (envelope.event._tag === "StreamSynchronized") {
                      yield* Deferred.succeed(eventsServed, void 0)
                    }
                    client.setConnectionIssue(Option.none())
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
                    Deferred.succeed(runtimeServed, void 0).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          client.setConnectionIssue(Option.none())
                          // The turn's own end, when it arrives, says how a stopped retry ended.
                          if (next._tag === "Idle") settleRetryingEvents(setStore, "stopped")
                          client.applySessionRuntime({
                            sessionId: session,
                            branchId: branch,
                            runtime: next,
                          })
                          callbacks.onQueueSnapshot(next.queue)
                        }),
                      ),
                    ),
                  ),
                  Effect.forkScoped,
                )

              yield* Effect.sync(() => setStreamReady(true))

              return yield* Effect.raceFirst(Fiber.join(eventsFiber), Fiber.join(runtimeFiber))
            }).pipe(
              // One scope per attempt: the stream that is still open when
              // the other ends closes with the attempt, so a retry never
              // leaves a second subscription behind.
              Effect.scoped,
            ),
          {
            label: "feed.events",
            log: client.log,
            onError: (err) => {
              client.log.error("feed.error", {
                key,
                error: formatConnectionIssue(err),
              })
              client.setConnectionIssue(Option.some(formatConnectionIssue(err)))
            },
            waitForRetry: () => client.waitForTransportReady,
          },
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
      if (envelope.event._tag === "StreamSynchronized") {
        // Replay is complete; later envelopes are live. The marker shares the cursor id
        // with the last replayed event, so it must not enter the duplicate set.
        lastSeenEventId = Math.max(lastSeenEventId, envelope.event.lastEventId)
        client.finishReplay()
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
      lastSeenEventId = Math.max(lastSeenEventId, envelope.id)
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
   * already holds their settled message, tool, and metric state, so replay
   * rebuilds the event-only UI rows and the answer still in progress, and
   * stamps them with the recorded time.
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
        handleToolCallResult(setStore, setRunningCalls, event, envelope.createdAt)
        return
      }

      switch (event._tag) {
        case "StreamStarted":
          // A new step means the last step's retries ran.
          settleRetryingEvents(setStore, "retried")
          if (live) setRunningCalls([])
          yield* openStreamedAnswer(event, stampedAt, live)
          break

        case "StreamChunk":
          // The answer streams: the retry ran.
          settleRetryingEvents(setStore, "retried")
          yield* appendStreamedChunk(event.chunk, stampedAt, live)
          break

        default:
          applySettledEvent(event, envelope.createdAt, stampedAt, live)
          break
      }
    })

  return {
    items,
    messages: () => store.messages,
    activeTool: () => runningLabel(runningCalls()),
  }
}

// ── session controller ──────────────────────────────────────────────────────

/**
 * A submitted slash command. `send` sends its text as a message: a path no
 * command source names. `refuse` gives it back to its draft with a reason: an
 * unknown name, or the view going before it could run.
 */
export interface SlashSubmission {
  readonly cmd: string
  readonly args: string
  readonly send: () => void
  readonly refuse: (reason: string) => void
}

/** A running `!cmd` was stopped: ctrl+c, or the session view went. Nothing is sent. */
class ShellStopped extends Schema.TaggedError<ShellStopped>()("ShellStopped", {
  command: Schema.String,
}) {}

export interface SessionController {
  items: () => SessionItem[]
  /**
   * Every notice-row source answered, or history stopped holding for it at
   * `NOTICE_ROWS_BOUND`: the items may reach native history.
   */
  itemsSettled: () => boolean
  messages: () => Message[]
  /** The providers the newest auth check read: the status row names a provider by them. */
  authProviders: () => ReadonlyArray<AuthProviderInfo>
  forkMessages: () => readonly DurableMessage[]
  queueState: () => QueueState
  composerState: () => ComposerState
  interactionState: () => ComposerInteractionState
  saveDraft: (draft: ComposerDraft) => void
  uiState: () => ReturnType<typeof SessionUiState.initial>
  /** The `ctrl+r` palette: its state, its entries, and its key handling. */
  promptSearch: PromptSearchController
  activity: () => { phase: "idle" } | { phase: "thinking" } | { phase: "tool"; toolInfo: string }
  /** The phase word: `idle`/`ready` for the status row, `Generating` or the tool for the activity row. */
  phaseLabel: () => string
  /** The status row's cue while a key's second press is armed (`esc again to clear`). */
  armedCue: () => Option.Option<string>
  elapsed: () => number
  onComposerInteraction: (event: ComposerInteractionEvent) => void
  /**
   * Send a submission to the session it was drafted in (`target`), never "the
   * current one". A rejected submission fails, and the composer gives it back.
   */
  onSubmit: (
    content: string,
    mode: "queue" | "interject",
    target: SessionIdentity,
    requestId: string,
  ) => Effect.Effect<void, GentClientRpcError>
  /**
   * Run a slash command. One no command source names, once every source has
   * answered, is not a command: a path goes out as a message (`send`), any
   * other name comes back to its draft (`refuse`).
   */
  onSlashCommand: (command: SlashSubmission) => Effect.Effect<void>
  /**
   * Runs a `!cmd` as this view's: the activity row shows `$ command` while it
   * runs, and ctrl+c, or the view going, stops it with `ShellStopped`.
   */
  runShell: <A, E, R>(
    command: string,
    run: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ShellStopped, R>
  onRestoreQueue: () => void
  dispatchComposer: (event: ComposerEvent) => void
  resolveAuthGate: () => void
  closeOverlay: () => void
  /** The name the picker shows, and the name a branch switch keeps. */
  currentSessionName: () => string
  onBranchPickerSelect: (branchId: BranchId) => void
  onForkSelect: (messageId: MessageId) => void
  onModelSelect: (modelId: ModelId) => void
  /** `None` clears the session override so config/agent defaults apply. */
  onReasoningSelect: (level: Option.Option<ReasoningEffort>) => void
}

/** The key whose second press is armed: Esc clears a draft, ctrl+c exits. */
type ArmedKey = "escape" | "interrupt"

/** What the status row says while a key is armed. */
const ARMED_CUE = {
  escape: "esc again to clear",
  interrupt: "ctrl+c again to exit",
} satisfies Record<ArmedKey, string>

/**
 * The reader's exit: the session view's and the fatal screen's. It leaves
 * the terminal as every shutdown does (`leaveTerminal`), then names the way
 * back. The session id is the only way back into this conversation, and it
 * is about to leave the screen. It is printed after the renderer is
 * destroyed, so it lands in the terminal the reader keeps. An in-memory
 * store ends with the process, so it has nothing to resume. A second exit
 * while that runs does nothing.
 */
export const useExit = () => {
  const client = useClient()
  const renderer = useRenderer()
  const env = useEnv()
  let leavingNow = false
  return () => {
    if (leavingNow) return
    leavingNow = true
    const leaving = client.activeSessionId()
    client.runtime.cast(
      leaveTerminal(renderer, env.writeTerminal).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (env.resumable) env.writeTerminal(`\nto resume: gent resume ${leaving}\n`)
            shutdownLog("exit.shutdown-signal")
            env.shutdown()
          }),
        ),
      ),
    )
  }
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
  /** The model is scripted (`--debug`, `--mock-empty`): it needs no sign-in. */
  scriptedModel?: boolean
}): SessionController {
  const client = useClient()
  const command = useCommand()
  const ext = useExtensionUI()
  const refusals = useComposerRefusals()
  const { takePrompt, restore } = useComposerMemory()
  const { cast } = useRuntime()
  const exit = useExit()
  // ── exit and cancel ladder: the armed key ──
  //
  // A destructive second press is armed by the first, and the status row says
  // so (`armedCue`): Esc on a draft arms its clear, ctrl+c on an idle empty
  // composer arms the exit, and so does a ctrl+c that cancels a turn, so a
  // second ctrl+c exits even when a new turn started in between (children
  // that keep waking the session). The arm is per key: a ctrl+c then an Esc
  // is two gestures. Any other key (an Esc included, when ctrl+c is armed), a
  // paste, a keybind, or the window running out disarms it; the window runs on
  // the runtime's clock, and its timer ends with the arm or with the view.
  const ARM_WINDOW = Duration.seconds(1)
  const [armedKey, setArmedKey] = createSignal(Option.none<ArmedKey>())
  let armTimer = Option.none<Fiber.Fiber<void>>()
  const stopArmTimer = () => {
    if (Option.isSome(armTimer)) client.runtime.cast(Fiber.interrupt(armTimer.value))
    armTimer = Option.none()
  }
  const disarm = () => {
    stopArmTimer()
    if (Option.isSome(untrack(armedKey))) setArmedKey(Option.none())
  }
  const arm = (key: ArmedKey) => {
    stopArmTimer()
    setArmedKey(Option.some(key))
    armTimer = Option.some(
      client.runtime.fork(
        Effect.sleep(ARM_WINDOW).pipe(
          Effect.andThen(
            Effect.sync(() => {
              armTimer = Option.none()
              setArmedKey(Option.none())
            }),
          ),
        ),
      ),
    )
  }
  onCleanup(stopArmTimer)
  const armedFor = (key: ArmedKey) => Option.contains(untrack(armedKey), key)
  const history = usePromptHistory()
  const frecency = useAutocompleteFrecency()

  const currentSessionName = (): string => client.session().name

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
  const [controllerState, setControllerState] = createSignal(initialSessionControllerState())
  // The providers the newest auth check read, with the names `/auth` shows.
  const [authProviders, setAuthProviders] = createSignal<ReadonlyArray<AuthProviderInfo>>([])
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
        if (props.scriptedModel === true) return
        if (pickerOpen) return
        Option.match(agentName, {
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
                      // The newest check names the providers: the status row labels by them.
                      if (version === controllerState().authCheckVersion)
                        setAuthProviders(providers)
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
                      client.setError(
                        `Authentication check failed: ${extractUnknownMessage(error)}`,
                      )
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
    props.scriptedModel !== true &&
    (authGateState() !== "closed" || !Equal.equals(validatedAgent(), client.agent()))

  const [composerState, setComposerState] = createSignal<ComposerState>(
    ComposerState.cases.idle.make({}),
  )
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

  const onBranchPickerSelect = (branchId: BranchId) => {
    dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))
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
    const sessionId = client.activeSessionId()
    if (client.isReconnecting()) return { sessionId, state: "unknown" }
    if (isBlockingAuthGate(authGateState()) || composerState()._tag === "interaction") {
      return { sessionId, state: "blocked" }
    }
    // A turn that runs is working, whatever error shows beside it.
    if (client.isStreaming()) return { sessionId, state: "working" }
    if (client.isError()) return { sessionId, state: "blocked" }
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

  const onInteraction = (interaction: InteractionPresented) => {
    dispatchComposer(ComposerEvent.cases.EnterInteraction.make({ interaction }))
  }

  const onComposerInteraction = (event: ComposerInteractionEvent) => {
    setInteractionState((current) =>
      transitionComposerInteraction(current, event, ext.autocompleteItems()),
    )
  }

  const feed = useSessionFeed(
    props.sessionId,
    props.branchId,
    client,
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
    // The startup prompt is a submission: it takes its place in send order,
    // and a refused one comes back to the draft of its branch with its reason.
    () =>
      Option.map(takePrompt(props.sessionId), (content): StartupPrompt => {
        const order = refusals.nextOrder()
        return {
          content,
          refuse: (target, reason, lost) => {
            client.setErrorIn(target, reason)
            refusals.refuse(
              target.branchId,
              { order, text: content, shell: false, requestId: lost },
              () => client.dismissErrorIn(target, reason),
            )
          },
        }
      }),
    // Gate prompt send on auth resolution and on the branch picker — the feed
    // waits for the stream plus this signal.
    () => !authGatePending() && !branchPickerOpen(),
  )

  const notices = createMemo<NoticeRowItems>(
    (previous) =>
      noticeRowItems(
        ext.noticeRows(),
        { sessionId: props.sessionId, branchId: props.branchId },
        previous.items,
      ),
    { items: new Map(), pending: [] },
  )
  // A source that never answers would hold native history for good. Once the
  // client extensions loaded, history holds NOTICE_ROWS_BOUND for each source
  // still deriving for this branch, then stops holding for it. The source is
  // not a failure: it stays, and a later answer draws its rows. The warning
  // names only a source still deriving at the bound. The view remounts per
  // session and branch, so a source id is a whole key.
  const noticeRowsHolds = new Map<string, Fiber.Fiber<void>>()
  const [releasedNoticeRows, setReleasedNoticeRows] = createSignal<ReadonlySet<string>>(new Set())
  onCleanup(() => {
    for (const fiber of noticeRowsHolds.values()) client.runtime.cast(Fiber.interrupt(fiber))
  })
  const noticeRowsPending = (id: string) => notices().pending.some((source) => source.id === id)
  createEffect(() => {
    if (!ext.loaded()) return
    for (const source of notices().pending) {
      if (noticeRowsHolds.has(source.id)) continue
      const release = Effect.sleep(NOTICE_ROWS_BOUND).pipe(
        Effect.andThen(
          Effect.sync(() => setReleasedNoticeRows((current) => new Set([...current, source.id]))),
        ),
        Effect.andThen(
          Effect.logWarning("tui.notice-rows.bound").pipe(
            Effect.annotateLogs({
              extension: source.extensionId,
              source: source.id,
              bound: Duration.format(NOTICE_ROWS_BOUND),
            }),
            Effect.when(Effect.sync(() => noticeRowsPending(source.id))),
          ),
        ),
        Effect.asVoid,
      )
      noticeRowsHolds.set(source.id, client.runtime.fork(release))
    }
  })
  const noticeRowsSettled = () => {
    const released = releasedNoticeRows()
    return notices().pending.every((source) => released.has(source.id))
  }
  const items = createMemo<SessionItem[]>(() => {
    const rows = notices().items
    if (rows.size === 0) return feed.items()
    return [...feed.items(), ...rows.values()].sort(compareSessionItems)
  })
  const promptSearch = createPromptSearchController({
    state: () => {
      const overlay = uiState().overlay
      if (overlay._tag === "prompt-search") return overlay.state
      return closedPromptSearch()
    },
    entries: history.entries,
    draft: () => interactionState().draft,
    dispatch: (event) => dispatchSessionUi(SessionUiEvent.cases.PromptSearch.make({ event })),
  })

  // ── the running `!cmd` ──
  //
  // A `!cmd` has no time limit; it runs until it ends, ctrl+c stops it, or the
  // view goes. Each one runs against its own stop signal, and the activity
  // row names the latest while any runs.
  interface RunningShell {
    readonly command: string
    readonly stop: Deferred.Deferred<void>
  }
  const [runningShells, setRunningShells] = createSignal<ReadonlyArray<RunningShell>>([])
  const runShell = <A, E, R>(
    command: string,
    run: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ShellStopped, R> =>
    Effect.gen(function* () {
      const running: RunningShell = { command, stop: yield* Deferred.make<void>() }
      const stopped = Deferred.await(running.stop).pipe(
        Effect.andThen(Effect.fail(new ShellStopped({ command }))),
      )
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => setRunningShells((shells) => [...shells, running])),
        () => Effect.raceFirst(run, stopped),
        () => Effect.sync(() => setRunningShells((shells) => shells.filter((s) => s !== running))),
      )
    })
  /** Stops every running `!cmd`; true when one was running. */
  const stopShells = () => {
    const shells = untrack(runningShells)
    for (const shell of shells) client.runtime.cast(Deferred.done(shell.stop, Exit.void))
    return shells.length > 0
  }
  onCleanup(stopShells)

  const activity = (): ReturnType<SessionController["activity"]> => {
    const shell = Option.fromUndefinedOr(runningShells().at(-1))
    if (Option.isSome(shell)) return { phase: "tool", toolInfo: `$ ${shell.value.command}` }
    if (!client.isStreaming()) return { phase: "idle" }
    const tool = feed.activeTool()
    if (Option.isSome(tool)) {
      return { phase: "tool", toolInfo: tool.value }
    }
    return { phase: "thinking" }
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

  // The status row reads the label while idle, the activity row while a tool runs.
  const phaseLabel = createMemo(() => {
    const nextActivity = activity()
    switch (nextActivity.phase) {
      case "idle":
        if (Option.exists(client.turnsStarted(), (turns) => turns > 0)) return "idle"
        return "ready"
      case "thinking":
        return "Generating"
      case "tool":
        return nextActivity.toolInfo
    }
  })

  const openForkPicker = () => {
    cast(
      client.client.message.list({ branchId: props.branchId }).pipe(
        Effect.tap((messages) =>
          Effect.sync(() => {
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
    frecency: frecency.lookup,
    recordPick: (id: string) => frecency.record("/", id),
    resetFrecency: () => frecency.reset(),
    openForkPicker,
    openModelPicker: () =>
      dispatchSessionUi(SessionUiEvent.cases.OpenSettingsPicker.make({ picker: "model" })),
    openReasoningPicker: () =>
      dispatchSessionUi(SessionUiEvent.cases.OpenSettingsPicker.make({ picker: "reasoning" })),
    openAuth: () => dispatchSessionUi(SessionUiEvent.cases.OpenAuth.make({ enforceAuth: false })),
    openPalette: command.openPalette,
  })

  // The queue and the draft it comes back to are this branch's, whichever
  // session is in view when the drain answers.
  const onRestoreQueue = () => {
    const origin: SessionIdentity = { sessionId: props.sessionId, branchId: props.branchId }
    cast(
      client.drainQueuedMessages(origin).pipe(
        Effect.tap(({ steering, followUp }) =>
          Effect.sync(() => {
            const text = queuedDraftText({ steering, followUp })
            if (Option.isNone(text)) return
            restore(origin.branchId, text.value)
            updateControllerState(clearQueue)
          }),
        ),
        Effect.catchEager((error) =>
          Effect.sync(() => client.setErrorIn(origin, formatError(error))),
        ),
      ),
    )
  }

  const closeOverlay = () => dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))

  const resolveAuthGate = () => {
    updateControllerState((state) => closeAuthGateState(state, client.agent()))
    closeOverlay()
  }

  // A name no source carries is a typo: it comes back to its draft. A first
  // word that reads as a path, with a second `/` or a `.`, is text for the
  // model, so it goes out as a message.
  const runSlashCommand = (held: SlashSubmission) => {
    if (executeSlashCommand(held.cmd, held.args, ext.commands())) return
    if (held.cmd.includes("/") || held.cmd.includes(".")) held.send()
    else held.refuse(`Unknown command: /${held.cmd} · ctrl+p commands`)
  }

  // A command sent before every command source has answered (the client
  // extensions' load, the session's server slash list) may belong to one of
  // them: it waits for them to settle, then resolves. Only settled sources
  // decide that a name is no command, and a name they lack lists the server's
  // commands once more first: an extension can register a command after the
  // session listed them. A command still held when the session view goes
  // comes back to its draft.
  let heldSlashCommands: ReadonlyArray<SlashSubmission> = []
  createEffect(
    on(ext.commandsSettled, (settled) => {
      if (!settled || heldSlashCommands.length === 0) return
      const held = heldSlashCommands
      heldSlashCommands = []
      for (const command of held) runSlashCommand(command)
    }),
  )
  onCleanup(() => {
    const held = heldSlashCommands
    heldSlashCommands = []
    for (const command of held) {
      command.refuse(`Not run: /${command.cmd} was still waiting for the session's commands`)
    }
  })

  const onSlashCommand = (command: SlashSubmission): Effect.Effect<void> =>
    Effect.sync(() => {
      if (isSlashCommandName(command.cmd, ext.commands())) {
        runSlashCommand(command)
        return
      }
      // Held first: a listing that answers at once settles before this returns.
      const settled = ext.commandsSettled()
      heldSlashCommands = [...heldSlashCommands, command]
      if (settled) ext.refreshCommands()
    })

  const onModelSelect = (modelId: ModelId) => {
    closeOverlay()
    cast(client.updateSessionSettings({ modelId: Option.some(modelId) }))
  }

  const onReasoningSelect = (level: Option.Option<ReasoningEffort>) => {
    closeOverlay()
    cast(client.updateSessionSettings({ reasoningLevel: level }))
  }

  const onForkSelect = (messageId: MessageId) => {
    dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))
    cast(client.forkBranch(messageId))
  }

  const onSubmit = (
    content: string,
    mode: "queue" | "interject",
    target: SessionIdentity,
    requestId: string,
  ): Effect.Effect<void, GentClientRpcError> => {
    // Interjecting steers the stream in view, so it holds only while the
    // drafted-in session is still the one streaming; otherwise the message queues there.
    const stillHere = sameIdentity(client.sessionIdentity(), target)
    if (mode === "interject" && stillHere && client.isStreaming()) {
      return client.steer(
        target,
        SteerCommandInput.cases.Interject.make({ message: content }),
        requestId,
      )
    }
    return client.sendMessage(target, content, requestId)
  }
  /** Cancel the turn streaming in the session in view. */
  const cancelTurn = () => {
    const target = client.sessionIdentity()
    cast(
      randomId.pipe(
        Effect.flatMap((requestId) =>
          client.steer(target, SteerCommandInput.cases.Cancel.make({}), requestId),
        ),
        client.surfaceError,
      ),
    )
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

  // One rule for Esc and ctrl+c over open UI: the palette, then the expanded
  // transcript under it, closes before the key reaches the draft or the turn.
  // A press that closes a layer arms nothing.
  const closeOpenLayer = (): boolean => {
    if (command.paletteOpen()) {
      command.closePalette()
      return true
    }
    if (uiState().transcriptExpanded) {
      dispatchSessionUi(SessionUiEvent.cases.ToggleTranscript.make({}))
      return true
    }
    return false
  }

  /**
   * ctrl+c undoes the nearest thing, then exits on a second press. A press
   * that cancels a turn arms the exit, and a second press in the window exits
   * whatever started since: a session that children keep waking has a new
   * turn running at every press, and cancelling each one would never let the
   * reader leave. Something nearer that appeared since (the palette, an
   * expanded transcript, a draft, a running `!cmd`) still comes first: the
   * press closes, clears or stops it and never exits over it. On an idle empty composer the first press only
   * arms the exit.
   */
  const handleInterrupt = () => {
    const second = armedFor("interrupt")
    disarm()
    const overlay = uiState().overlay
    if (overlayHoldsComposer(overlay)) {
      // The boot branch picker and an enforced sign-in hold the slot: there
      // is nothing behind them to fall back to, so ctrl+c arms the exit as on
      // an empty composer (Esc does nothing over them). Any other held pane
      // is the nearest thing, and ctrl+c closes it as Esc does.
      if (slotHeld(overlay)) {
        if (second) exit()
        else arm("interrupt")
        return
      }
      closeOverlay()
      return
    }
    if (closeOpenLayer()) return
    if (interactionState().draft.length > 0) {
      onComposerInteraction(ComposerInteractionEvent.cases.ClearDraft.make({}))
      return
    }
    // A running `!cmd` is nearer than the turn: the press stops it and arms nothing.
    if (stopShells()) return
    if (second) {
      exit()
      return
    }
    if (client.isStreaming()) cancelTurn()
    arm("interrupt")
  }

  // Esc steps back one layer: the open layer, disclosure, turn, then the
  // draft, which the first press arms and the second clears. Esc never exits.
  const handleEscape = () => {
    const second = armedFor("escape")
    disarm()
    if (closeOpenLayer()) return
    if (uiState().disclosure !== "collapsed") {
      dispatchSessionUi(SessionUiEvent.cases.CollapseDisclosure.make({}))
      return
    }
    if (client.isStreaming()) {
      cancelTurn()
      return
    }
    if (interactionState().draft.length === 0) return
    if (second) {
      onComposerInteraction(ComposerInteractionEvent.cases.ClearDraft.make({}))
      return
    }
    arm("escape")
  }

  // Any other key or a paste disarms (a keybind, a transcript toggle, a typed
  // character, also one a docked pane takes, or the other armed key: an Esc
  // that leaves shell mode disarms a ctrl+c). The armed key reads its own arm
  // in its branch.
  useInputWatch({
    key: (event) => {
      if (event.name === "escape" && armedFor("escape")) return
      if (event.ctrl === true && event.name === "c" && armedFor("interrupt")) return
      disarm()
    },
    paste: disarm,
  })

  // The composer is empty and nothing sits over it: no overlay, pane,
  // interaction or full transcript that reads a key first or hides it.
  const composerEmpty = (): boolean =>
    interactionState().draft.length === 0 &&
    uiState().overlay._tag === "none" &&
    !uiState().transcriptExpanded &&
    composerState()._tag !== "interaction"

  // A bare keybind (`left` opens the agents pane) fires only on an empty
  // editing draft: shell mode reads the key itself.
  const composerIdle = (): boolean => composerEmpty() && interactionState().mode === "editing"

  // ctrl+d on an empty composer exits, in shell mode too; on a draft it
  // deletes forward in the composer. An ask, an open pane or palette, and the
  // expanded transcript are layers over it, as for Esc and ctrl+c.
  const handleEmptyComposerExit = (event: ScopedKeyboardEvent): boolean => {
    if (event.ctrl !== true || event.name !== "d") return false
    if (!composerEmpty() || command.paletteOpen()) return false
    exit()
    return true
  }

  useScopedKeyboard((event) => {
    const interrupt = event.ctrl === true && event.name === "c"
    // A keybind is another gesture, so it disarms an armed key.
    if (command.handleKeybind(event, ext.commands(), composerIdle())) {
      disarm()
      return true
    }
    if (interrupt) {
      handleInterrupt()
      return true
    }
    const overlay = uiState().overlay
    // An open pane takes its own Esc. One that reaches here found no row of
    // the pane on a short terminal (`KeyboardGate`), and it closes the pane as
    // the pane's own Esc does, held or not, so it never cancels the turn
    // behind it. The panes that hold the slot keep theirs.
    if (event.name === "escape" && overlay._tag !== "none") {
      if (slotHeld(overlay)) return false
      if (overlay._tag === "pane") {
        dispatchSessionUi(SessionUiEvent.cases.ClosePane.make({ id: overlay.id }))
      } else {
        closeOverlay()
      }
      disarm()
      return true
    }
    if (overlayHoldsComposer(overlay)) return false

    if (event.name === "escape") {
      handleEscape()
      return true
    }

    if (handleEmptyComposerExit(event)) return true

    if (event.ctrl === true && event.name === "r") {
      promptSearch.open()
      disarm()
      return true
    }

    if (handleTranscriptKey(event)) return true

    return false
  })

  return {
    items,
    itemsSettled: noticeRowsSettled,
    messages: feed.messages,
    authProviders,
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
    armedCue: () => Option.map(armedKey(), (key) => ARMED_CUE[key]),
    elapsed,
    onComposerInteraction,
    onSubmit,
    onSlashCommand,
    runShell,
    onRestoreQueue,
    dispatchComposer,
    resolveAuthGate,
    closeOverlay,
    onForkSelect,
    onModelSelect,
    onReasoningSelect,
    currentSessionName,
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
