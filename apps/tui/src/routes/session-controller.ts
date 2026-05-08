import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
} from "solid-js"
import { Effect, Fiber, Random, Schedule } from "effect"
import type { ActiveInteraction } from "@gent/core-internal/domain/event.js"
import type { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids.js"
import type { ReasoningEffort } from "@gent/core-internal/domain/agent.js"
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
import type { Command } from "../command/types"
import { useRuntime } from "../hooks/use-runtime"
import { useExit } from "../hooks/use-exit"
import { useKeyChain } from "../hooks/use-key-chain"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useScopedKeyboard } from "../keyboard/context"
import { useRouter } from "../router/index"
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
  const { exit, handleEsc } = useExit()
  const quitChain = useKeyChain()
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
          ComposerInteractionEvent.RestoreDraft.make({ text: effect.text }),
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
      dispatchSessionUi(SessionUiEvent.OpenAuth.make({ enforceAuth: true }))
    }
  })

  // Wire extension overlay dispatch to session UI state
  ext.setOverlayDispatch(
    (id) => dispatchSessionUi(SessionUiEvent.OpenExtensionOverlay.make({ overlayId: id })),
    () => dispatchSessionUi(SessionUiEvent.CloseOverlay.make({})),
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
    dispatchComposer(ComposerEvent.EnterInteraction.make({ interaction }))
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
        dispatchComposer(ComposerEvent.DismissInteraction.make({ requestId }))
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
        SessionUiEvent.PromptSearch.make({
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
          dispatchSessionUi(SessionUiEvent.OpenTree.make({ tree, sessions }))
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
    dispatchSessionUi(SessionUiEvent.OpenFork.make({}))
  }

  // ── Session builtin commands ──
  // Routes through the shared `createSession` helper (generates a `requestId`
  // and updates the client-side session machine), so retry semantics and
  // dedup match every other create path instead of bypassing them with a
  // raw RPC call.
  const newSessionCmd = () => {
    client.createSession((sessionId, branchId) => {
      router.navigateToSession(sessionId, branchId)
    })
  }

  const sessionBuiltins: Command[] = [
    {
      id: "session.new",
      title: "New Session",
      category: "Session",
      slash: "new",
      aliases: ["clear"],
      slashPriority: 0,
      onSelect: newSessionCmd,
    },
    {
      id: "session.sessions",
      title: "Open Sessions",
      category: "Session",
      slash: "sessions",
      slashPriority: 0,
      onSelect: () => command.openPalette(),
    },
    {
      id: "session.branch",
      title: "Create Branch",
      category: "Session",
      slash: "branch",
      slashPriority: 0,
      onSelect: () => {
        cast(
          client.createBranch().pipe(
            Effect.asVoid,
            Effect.catchEager((error) =>
              Effect.sync(() => {
                client.setError(formatError(error))
              }),
            ),
          ),
        )
      },
    },
    {
      id: "session.tree",
      title: "Browse Branch Tree",
      category: "Session",
      slash: "tree",
      slashPriority: 0,
      onSelect: openSessionTree,
    },
    {
      id: "session.fork",
      title: "Fork from Message",
      category: "Session",
      slash: "fork",
      slashPriority: 0,
      onSelect: openForkPicker,
    },
    {
      id: "session.think",
      title: "Set Reasoning Level",
      category: "Session",
      slash: "think",
      slashPriority: 0,
      onSelect: () => {
        client.setError("Usage: /think <off|low|medium|high|xhigh>")
      },
      onSlash: (args) => {
        const level = args.trim().toLowerCase()
        const validLevels = ["off", "low", "medium", "high", "xhigh"]
        if (level === "" || !validLevels.includes(level)) {
          client.setError(`Usage: /think <${validLevels.join("|")}>`)
          return
        }
        cast(
          client
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
            .updateSessionReasoningLevel(level === "off" ? undefined : (level as ReasoningEffort))
            .pipe(
              Effect.catchEager((error) =>
                Effect.sync(() => {
                  client.setError(formatError(error))
                }),
              ),
            ),
        )
      },
    },
    {
      id: "session.permissions",
      title: "View/Edit Permissions",
      category: "Session",
      slash: "permissions",
      slashPriority: 0,
      onSelect: () => dispatchSessionUi(SessionUiEvent.OpenPermissions.make({})),
    },
    {
      id: "session.auth",
      title: "Manage API Keys",
      category: "Session",
      slash: "auth",
      slashPriority: 0,
      onSelect: () => dispatchSessionUi(SessionUiEvent.OpenAuth.make({ enforceAuth: false })),
    },
  ]

  // Register session builtins + extension commands, and derive / autocomplete
  {
    const unsubBuiltins = command.register(sessionBuiltins)
    let unsubExtCommands: (() => void) | undefined
    createEffect(() => {
      unsubExtCommands?.()
      const cmds = ext.commands()
      if (cmds.length > 0) {
        unsubExtCommands = command.register([...cmds])
      }
    })

    // Derive / autocomplete from the full command registry
    createEffect(() => {
      const allCommands = command.commands()
      ext.setDynamicAutocomplete([
        {
          prefix: "/",
          title: "Commands",
          items: (filter: string) => {
            const lowerFilter = filter.toLowerCase()
            const hasFilter = lowerFilter.length > 0
            const items: Array<{ id: string; label: string; description?: string }> = []
            for (const c of allCommands) {
              if (c.slash === undefined) continue
              // Primary name always shown if it matches (or no filter)
              if (
                !hasFilter ||
                c.slash.toLowerCase().includes(lowerFilter) ||
                c.title.toLowerCase().includes(lowerFilter)
              ) {
                items.push({
                  id: c.slash,
                  label: `/${c.slash}`,
                  description: c.description ?? c.title,
                })
              }
              // Aliases only shown when filter matches them specifically
              if (hasFilter) {
                for (const alias of c.aliases ?? []) {
                  if (alias.toLowerCase().includes(lowerFilter)) {
                    items.push({
                      id: alias,
                      label: `/${alias}`,
                      description: c.description ?? c.title,
                    })
                  }
                }
              }
            }
            return items
          },
        },
      ])
    })

    onCleanup(() => {
      unsubBuiltins()
      unsubExtCommands?.()
      ext.setDynamicAutocomplete([])
    })
  }

  const onRestoreQueue = () => {
    cast(
      client.drainQueuedMessages().pipe(
        Effect.tap(({ steering, followUp }) =>
          Effect.sync(() => {
            const text = queuedDraftText({ steering, followUp })
            if (text === undefined) return
            onComposerInteraction(
              ComposerInteractionEvent.RestoreDraft.make({
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

  const closeOverlay = () => dispatchSessionUi(SessionUiEvent.CloseOverlay.make({}))

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
    dispatchSessionUi(SessionUiEvent.CloseOverlay.make({}))
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
    dispatchSessionUi(SessionUiEvent.CloseOverlay.make({}))
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
      client.steer(SteerCommandInput.Interject.make({ message: content, agent: client.agent() }))
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
      onComposerInteraction(ComposerInteractionEvent.ClearDraft.make({}))
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
        client.steer(SteerCommandInput.Cancel.make({}))
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
      dispatchSessionUi(SessionUiEvent.ToggleTools.make({}))
      return true
    }

    if (event.ctrl === true && event.shift === true && event.name === "m") {
      dispatchSessionUi(SessionUiEvent.OpenMermaid.make({}))
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
