import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { useRenderer } from "@opentui/solid"
import { DateTime, Effect, Fiber, Option, Random, Schedule } from "effect"
import { useEnv } from "../env/context"
import { shutdownLog } from "../utils/client-logger"
import { useRequiredContext } from "../utils/solid-context"
import type {
  ActiveInteraction,
  Branch,
  BranchId,
  MessageId,
  Message as DurableMessage,
  ModelId,
  ReasoningEffort,
  SessionId,
} from "@gent/core/protocol"
import type { Message, SessionItem } from "../components/message-list"
import {
  ComposerInteractionEvent,
  ComposerInteractionState,
  transitionComposerInteraction,
} from "../components/composer-interaction-state"
import {
  ComposerEvent,
  transition,
  type ComposerEffect,
  ComposerState,
} from "../components/composer-state"
import { useClient, SteerCommandInput } from "../client/index"
import { executeSlashCommand } from "../commands/slash-commands"
import { useCommand } from "../command/context"
import { useRuntime } from "../hooks/use-runtime"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useScopedKeyboard, type ScopedKeyboardEvent } from "../keyboard/context"
import { useSessionShell } from "../session-shell"
import { formatError } from "../utils/format-error"
import { useExtensionUI } from "../extensions/context"
import { useChildSessions } from "../hooks/use-child-sessions"
import { useSessionFeed } from "../hooks/use-session-feed"
import {
  SessionUiEvent,
  SessionUiState,
  transitionSessionUi,
  type SessionUiEffect,
} from "./session-ui-state"
import {
  createPromptSearchController,
  type PromptSearchController,
} from "./prompt-search-controller"
import { PromptSearchState } from "../components/prompt-search-state"
import {
  beginAuthCheck,
  clearQueue,
  closeAuthGate as closeAuthGateState,
  completeAuthCheck,
  failAuthCheck,
  formatAuthGateError,
  initialSessionControllerState,
  isBlockingAuthGate,
  queuedDraftText,
  setElapsed as setControllerElapsed,
  setQueue,
  type QueueState,
} from "./session-controller-state"
import { currentMillis, pickThinkingWord } from "./session-controller-activity"
import { createSessionCommandRegistry } from "./session-command-registry"
import { useComposerDrafts, type ComposerDraft } from "../components/composer-drafts"

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
  getChildren: ReturnType<typeof useChildSessions>["getChildren"]
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
    shutdownLog("exit.renderer-destroy")
    renderer.destroy()
    shutdownLog("exit.shutdown-signal")
    env.shutdown()
  }
  const ESC_DOUBLE_TAP_MS = 1_000
  let lastEscTime = 0
  const handleEsc = (): boolean => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
    if (now - lastEscTime < ESC_DOUBLE_TAP_MS) {
      exit()
      return true
    }
    lastEscTime = now
    return false
  }
  const QUIT_CHAIN_WINDOW_MS = 1_000
  let quitArmed: Option.Option<{ id: string; at: number }> = Option.none()
  const quitChain = {
    trigger: (id: string, actions?: { first?: () => void; second: () => void }) => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
      const isSecond = Option.exists(
        quitArmed,
        (armed) => armed.id === id && now - armed.at < QUIT_CHAIN_WINDOW_MS,
      )
      if (isSecond) {
        quitArmed = Option.none()
        actions?.second()
        return
      }
      quitArmed = Option.some({ id, at: now })
      actions?.first?.()
    },
    reset: () => {
      quitArmed = Option.none()
    },
  }
  const history = usePromptHistory()

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

  const [uiState, setUiState] = createSignal(SessionUiState.initial())

  /**
   * Whether the reader still owes this session a branch. Its own signal, not a
   * read of the overlay: the auth gate writes the overlay, so deriving the
   * gate from the overlay would make the auth check re-run on its own effect.
   */
  const [branchPickerOpen, setBranchPickerOpen] = createSignal(Option.isSome(props.initialBranches))

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
  const { getChildren } = useChildSessions(client)

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

  // The picker is the first thing a resumed multi-branch session shows.
  // `onMount` rather than an effect: the branches come from the bootstrap and
  // never change, so this opens once and the reader owns the pane after that.
  onMount(() => {
    Option.match(props.initialBranches, {
      onNone: () => {},
      onSome: (branches) => {
        dispatchSessionUi(SessionUiEvent.cases.OpenBranches.make({ branches }))
      },
    })
  })

  /**
   * Escape leaves the picker, not the list. The boot flow is where a session
   * with several branches starts, so with no branch chosen the only way out
   * is to quit — the same exit the picker route had.
   */
  const onBranchPickerDismiss = () => {
    exit()
  }

  const onBranchPickerSelect = (branchId: BranchId) => {
    setBranchPickerOpen(false)
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

  // Wire extension overlay dispatch to session UI state
  ext.setOverlayDispatch(
    (id) => dispatchSessionUi(SessionUiEvent.cases.OpenExtensionOverlay.make({ overlayId: id })),
    () => dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({})),
  )

  ext.setSwitchSessionDispatch((input) => {
    client.switchSession(input.sessionId, input.branchId, input.name)
  })

  ext.setActivityProvider(() => {
    const session = Option.fromNullishOr(client.session())
    const sessionId = Option.getOrUndefined(Option.map(session, (value) => value.sessionId))
    const connection = Option.fromNullishOr(client.connectionState())
    if (
      client.isLoading() ||
      client.isReconnecting() ||
      (Option.isSome(connection) && connection.value._tag === "disconnected")
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
    Option.getOrUndefined(shell.promptFor(props.sessionId)),
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
    command,
    ext,
    cast,
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
      const result = executeSlashCommand(cmd, args, command.commands())
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
    quitChain.reset()
    if (uiState().overlay._tag !== "none") {
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
    if (command.handleKeybind(event)) return true
    if (event.ctrl === true && event.name === "c") {
      handleInterrupt()
      return true
    }
    if (uiState().overlay._tag !== "none") return false

    const clearComposer = () => {
      onComposerInteraction(ComposerInteractionEvent.cases.ClearDraft.make({}))
    }

    const handleQuitKey = (chainId: string) => {
      if (interactionState().draft.length > 0) {
        quitChain.trigger(chainId, { first: clearComposer, second: exit })
        return
      }
      quitChain.trigger(chainId, {
        first: () => {
          handleEsc()
        },
        second: exit,
      })
    }

    if (event.name === "escape") {
      if (uiState().transcriptExpanded && !command.paletteOpen()) {
        dispatchSessionUi(SessionUiEvent.cases.ToggleTranscript.make({}))
        quitChain.reset()
        return true
      }
      if (command.paletteOpen()) {
        command.closePalette()
        quitChain.reset()
        return true
      }
      if (uiState().disclosure !== "collapsed") {
        dispatchSessionUi(SessionUiEvent.cases.CollapseDisclosure.make({}))
        quitChain.reset()
        return true
      }

      if (client.isStreaming()) {
        client.steer(SteerCommandInput.cases.Cancel.make({}))
        quitChain.reset()
        return true
      }

      handleQuitKey("escape")
      return true
    }

    if (event.ctrl === true && event.name === "r") {
      promptSearch.open()
      quitChain.reset()
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
    getChildren,
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
