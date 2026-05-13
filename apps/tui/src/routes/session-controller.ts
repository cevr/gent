import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
} from "solid-js"
import { useRenderer } from "@opentui/solid"
import { Effect, Fiber, Random, Schedule } from "effect"
import { useEnv } from "../env/context"
import { shutdownLog } from "../utils/client-logger"
import type { ActiveInteraction } from "@gent/core-internal/domain/event.js"
import type { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids.js"
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
import {
  useClientActions,
  useClientAgent,
  useClientSession,
  useClientTransport,
  SteerCommandInput,
  type ClientContextValue,
} from "../client/index"
import { executeSlashCommand } from "../commands/slash-commands"
import { useCommand } from "../command/context"
import { useRuntime } from "../hooks/use-runtime"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useScopedKeyboard } from "../keyboard/context"
import { useRouter } from "../router"
import { formatError, type UiError } from "../utils/format-error"
import { useExtensionUI } from "../extensions/context"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { useChildSessions } from "../hooks/use-child-sessions"
import { useSessionFeed } from "../hooks/use-session-feed"
import {
  getPromptSearchState,
  SessionUiEvent,
  SessionUiState,
  transitionSessionUi,
  type SessionUiEffect,
} from "./session-ui-state"
import { createPromptSearchController } from "./prompt-search-controller"
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
import {
  currentMillis,
  defaultActivityDecor,
  pickActivityDecor,
} from "./session-controller-activity"
import { createSessionCommandRegistry } from "./session-command-registry"

export interface SessionController {
  client: ClientContextValue
  items: () => SessionItem[]
  messages: () => Message[]
  queueState: () => QueueState
  composerState: () => ComposerState
  interactionState: () => ComposerInteractionState
  uiState: () => ReturnType<typeof SessionUiState.initial>
  promptEntries: () => readonly string[]
  promptSearchState: () => ReturnType<typeof getPromptSearchState>
  promptSearchOpen: () => boolean
  toolsExpanded: () => boolean
  treeOverlay: () => ReturnType<typeof getTreeOverlay>
  activity: () =>
    | { phase: "idle"; turn: number }
    | { phase: "thinking"; turn: number }
    | { phase: "tool"; turn: number; toolInfo: string }
  spinner: () => string
  phaseLabel: () => string
  elapsed: () => number
  getChildren: ReturnType<typeof useChildSessions>["getChildren"]
  clearMessages: () => void
  onComposerInteraction: (event: ComposerInteractionEvent) => void
  onSubmit: (content: string, mode?: "queue" | "interject") => void
  onSlashCommand: (cmd: string, args: string) => Effect.Effect<void>
  onRestoreQueue: () => void
  dispatchComposer: (event: ComposerEvent) => void
  resolveAuthGate: () => void
  closeOverlay: () => void
  onSessionTreeSelect: (sessionId: SessionId) => void
  onForkSelect: (messageId: MessageId) => void
  onPromptSearchEvent: (event: Extract<SessionUiEvent, { _tag: "PromptSearch" }>["event"]) => void
}

const getTreeOverlay = (state: ReturnType<typeof SessionUiState.initial>["overlay"]) =>
  state._tag === "tree" ? state.tree : null

export function createSessionController(props: {
  sessionId: SessionId
  branchId: BranchId
  initialPrompt?: string
  debugMode?: boolean
  missingAuthProviders?: readonly string[]
}): SessionController {
  const transport = useClientTransport()
  const sessionClient = useClientSession()
  const agent = useClientAgent()
  const actions = useClientActions()
  const client: ClientContextValue = {
    ...transport,
    ...sessionClient,
    ...agent,
    ...actions,
  }
  const command = useCommand()
  const ext = useExtensionUI()
  const router = useRouter()
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
    const now = performance.timeOrigin + performance.now()
    if (now - lastEscTime < ESC_DOUBLE_TAP_MS) {
      exit()
      return true
    }
    lastEscTime = now
    return false
  }
  const QUIT_CHAIN_WINDOW_MS = 1_000
  let quitArmed: { id: string; at: number } | null = null
  const quitChain = {
    trigger: (id: string, actions?: { first?: () => void; second: () => void }) => {
      const now = performance.timeOrigin + performance.now()
      const isSecond = quitArmed?.id === id && now - quitArmed.at < QUIT_CHAIN_WINDOW_MS
      if (isSecond) {
        quitArmed = null
        actions?.second()
        return
      }
      quitArmed = { id, at: now }
      actions?.first?.()
    },
    reset: () => {
      quitArmed = null
    },
  }
  const history = usePromptHistory()
  const tick = useSpinnerClock()

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
      () => client.agent(),
      (agentName) => {
        if (props.debugMode || agentName === undefined) return
        const version = controllerState().authCheckVersion + 1
        updateControllerState(beginAuthCheck)
        client.runtime.cast(
          client.client.auth.listProviders({ agentName, sessionId: props.sessionId }).pipe(
            Effect.tap((providers) =>
              Effect.sync(() => {
                const missing = providers.some((p) => p.required && !p.hasKey)
                updateControllerState((state) =>
                  completeAuthCheck(state, { version, agent: agentName, missing }),
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
      { defer: false },
    ),
  )

  const authGatePending = () =>
    !props.debugMode && (authGateState() !== "closed" || validatedAgent() !== client.agent())
  const { getChildren } = useChildSessions(client)

  const [uiState, setUiState] = createSignal(SessionUiState.initial())
  const [composerState, setComposerState] = createSignal<ComposerState>(ComposerState.idle())
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
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

  createEffect(() => {
    if (isBlockingAuthGate(authGateState()) && uiState().overlay._tag !== "auth") {
      dispatchSessionUi(SessionUiEvent.cases.OpenAuth.make({ enforceAuth: true }))
    }
  })

  // Wire extension overlay dispatch to session UI state
  ext.setOverlayDispatch(
    (id) => dispatchSessionUi(SessionUiEvent.cases.OpenExtensionOverlay.make({ overlayId: id })),
    () => dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({})),
  )

  // Wire composer state for extensions — mirrors use-composer-controller's focus logic
  ext.setComposerStateProvider(() => {
    const is = interactionState()
    return {
      draft: is.draft,
      mode: is.mode,
      inputFocused:
        composerState()._tag !== "interaction" &&
        !command.paletteOpen() &&
        !promptSearch.isOpen() &&
        uiState().overlay._tag === "none",
      autocompleteOpen: is.autocomplete !== null,
    }
  })

  const handleComposerEffect = (effect: ComposerEffect | undefined) => {
    if (effect === undefined) return
    const { interaction, result } = effect
    cast(
      client.client.interaction
        .respondInteraction({
          requestId: interaction.requestId,
          sessionId: props.sessionId,
          branchId: props.branchId,
          approved: result.approved,
          ...(result.notes !== undefined ? { notes: result.notes } : {}),
        })
        .pipe(
          Effect.tapError((error: unknown) =>
            Effect.sync(() => {
              client.setError(
                typeof error === "object" && error !== null
                  ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
                    formatError(error as UiError)
                  : String(error),
              )
            }),
          ),
        ),
    )
  }

  const dispatchComposer = (event: ComposerEvent) => {
    const result = transition(composerState(), event)
    setComposerState(result.state)
    handleComposerEffect(result.effect)
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
        router.navigateToSession(sessionId, branchId)
      },
      onQueueSnapshot: (queue) => updateControllerState((state) => setQueue(state, queue)),
    },
    props.initialPrompt,
    // Gate prompt send on auth resolution — feed waits for stream + this signal
    () => !authGatePending(),
  )

  const items = createMemo<SessionItem[]>(() => feed.items())
  const promptSearch = createPromptSearchController({
    state: () => getPromptSearchState(uiState()),
    entries: history.entries,
    draft: () => interactionState().draft,
    dispatch: (event, entries) =>
      dispatchSessionUi(
        SessionUiEvent.cases.PromptSearch.make({
          event,
          entries,
        }),
      ),
  })

  const activity = () => {
    if (!client.isStreaming()) return { phase: "idle" as const, turn: feed.turnCount() }
    const tool = feed.activeTool()
    if (tool !== undefined) {
      return { phase: "tool" as const, turn: feed.turnCount(), toolInfo: tool }
    }
    return { phase: "thinking" as const, turn: feed.turnCount() }
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

  // Pick a random spinner + thinking word each time activity starts
  let activityDecor = defaultActivityDecor()
  createEffect(
    on(
      () => activity().phase,
      (phase) => {
        if (phase !== "idle") {
          client.runtime.cast(
            Effect.gen(function* () {
              const spinnerRandom = yield* Random.next
              const wordRandom = yield* Random.next
              const nextDecor = pickActivityDecor({ spinnerRandom, wordRandom })
              yield* Effect.sync(() => {
                activityDecor = nextDecor
              })
            }),
          )
        }
      },
    ),
  )

  const spinner = createMemo(() => {
    const t = tick()
    const step = Math.floor(t / activityDecor.spinner.multiplier)
    return activityDecor.spinner.frames[step % activityDecor.spinner.frames.length] ?? "·"
  })

  const phaseLabel = createMemo(() => {
    const nextActivity = activity()
    switch (nextActivity.phase) {
      case "idle":
        return nextActivity.turn > 0 ? "idle" : "ready"
      case "thinking":
        return activityDecor.word
      case "tool":
        return nextActivity.toolInfo ?? "working"
    }
  })

  const openSessionTree = () => {
    cast(
      Effect.gen(function* () {
        const sessions = yield* client.listSessions()
        const byId = new Map(sessions.map((session) => [session.id, session]))
        let rootId = props.sessionId
        let current = byId.get(props.sessionId)
        while (current?.parentSessionId !== undefined) {
          const parent = byId.get(current.parentSessionId)
          if (parent === undefined) break
          rootId = parent.id
          current = parent
        }

        const tree = yield* client.getSessionTree(rootId)
        yield* Effect.sync(() => {
          dispatchSessionUi(SessionUiEvent.cases.OpenTree.make({ tree, sessions }))
        })
      }).pipe(
        Effect.catchEager((error) =>
          Effect.sync(() => {
            client.setError(formatError(error))
          }),
        ),
      ),
    )
  }

  const openForkPicker = () => {
    if (feed.messages().length === 0) {
      client.setError("No messages to fork")
      return
    }
    dispatchSessionUi(SessionUiEvent.cases.OpenFork.make({}))
  }

  createSessionCommandRegistry({
    client,
    command,
    ext,
    cast,
    navigateToCreatedSession: (sessionId, branchId) => {
      router.navigateToSession(sessionId, branchId)
    },
    openSessionTree,
    openForkPicker,
    openPermissions: () => dispatchSessionUi(SessionUiEvent.cases.OpenPermissions.make({})),
    openAuth: () => dispatchSessionUi(SessionUiEvent.cases.OpenAuth.make({ enforceAuth: false })),
  })

  const onRestoreQueue = () => {
    cast(
      client.drainQueuedMessages().pipe(
        Effect.tap(({ steering, followUp }) =>
          Effect.sync(() => {
            const text = queuedDraftText({ steering, followUp })
            if (text === undefined) return
            onComposerInteraction(
              ComposerInteractionEvent.cases.RestoreDraft.make({
                text,
              }),
            )
            updateControllerState(clearQueue)
          }),
        ),
        Effect.catchEager((error) =>
          Effect.sync(() => {
            client.setError(formatError(error))
          }),
        ),
      ),
    )
  }

  const closeOverlay = () => dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))

  const resolveAuthGate = () => {
    updateControllerState((state) => closeAuthGateState(state, client.agent()))
    closeOverlay()
  }

  const onSlashCommand = (cmd: string, args: string): Effect.Effect<void> =>
    executeSlashCommand(cmd, args, command.commands()).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.error !== undefined) client.setError(result.error)
        }),
      ),
      Effect.asVoid,
    )

  const onSessionTreeSelect = (sessionId: SessionId) => {
    const currentOverlay = uiState().overlay
    dispatchSessionUi(SessionUiEvent.cases.CloseOverlay.make({}))
    if (currentOverlay._tag !== "tree") return

    const nextSession = currentOverlay.sessions.find((session) => session.id === sessionId)
    if (nextSession === undefined || nextSession.activeBranchId === undefined) {
      client.setError("Session tree entry missing active branch")
      return
    }

    client.switchSession(nextSession.id, nextSession.activeBranchId, nextSession.name ?? "Unnamed")
    router.navigateToSession(nextSession.id, nextSession.activeBranchId)
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
        Effect.catchEager((error) =>
          Effect.sync(() => {
            client.setError(formatError(error))
          }),
        ),
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

  useScopedKeyboard((event) => {
    if (promptSearch.handleKey(event)) {
      return true
    }

    if (command.handleKeybind(event)) return true
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
      if (command.paletteOpen()) {
        command.closePalette()
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

    if (event.ctrl === true && event.name === "c") {
      exit()
      return true
    }

    if (event.ctrl === true && event.name === "r") {
      promptSearch.open()
      quitChain.reset()
      return true
    }

    if (event.ctrl === true && event.name === "o") {
      dispatchSessionUi(SessionUiEvent.cases.ToggleTools.make({}))
      return true
    }

    if (event.ctrl === true && event.shift === true && event.name === "m") {
      dispatchSessionUi(SessionUiEvent.cases.OpenMermaid.make({}))
      return true
    }

    return false
  })

  return {
    client,
    items,
    messages: feed.messages,
    queueState,
    composerState,
    interactionState,
    uiState,
    promptEntries: history.entries,
    promptSearchState: () => getPromptSearchState(uiState()),
    promptSearchOpen: promptSearch.isOpen,
    toolsExpanded: () => uiState().toolsExpanded,
    treeOverlay: () => getTreeOverlay(uiState().overlay),
    activity,
    spinner,
    phaseLabel,
    elapsed,
    getChildren,
    clearMessages: feed.clear,
    onComposerInteraction,
    onSubmit,
    onSlashCommand,
    onRestoreQueue,
    dispatchComposer,
    resolveAuthGate,
    closeOverlay,
    onSessionTreeSelect,
    onForkSelect,
    onPromptSearchEvent: (event) => promptSearch.onEvent(event),
  }
}

// ── Context ──

export const SessionControllerContext = createContext<SessionController>()

export function useSessionController(): SessionController {
  const ctx = useContext(SessionControllerContext)
  if (ctx === undefined)
    throw new Error("useSessionController must be used within SessionControllerContext.Provider")
  return ctx
}
