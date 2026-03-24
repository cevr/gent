import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Effect, Fiber, Stream } from "effect"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids.js"
import type { QueueEntryInfo } from "@gent/sdk"
import type { Message, SessionItem } from "../components/message-list"
import {
  ComposerInteractionState,
  transitionComposerInteraction,
  type ComposerInteractionEvent,
} from "../components/composer-interaction-state"
import { transition, type ComposerEvent, ComposerState } from "../components/composer-state"
import { useClient } from "../client/index"
import { executeSlashCommand } from "../commands/slash-commands"
import { useCommand } from "../command/index"
import { useRuntime } from "../hooks/use-runtime"
import { useExit } from "../hooks/use-exit"
import { useKeyChain } from "../hooks/use-key-chain"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useScopedKeyboard } from "../keyboard/context"
import { useRouter } from "../router/index"
import {
  ClientError,
  formatConnectionIssue,
  formatError,
  type UiError,
} from "../utils/format-error"
import { useWorkspace } from "../workspace/index"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { useChildSessions } from "../hooks/use-child-sessions"
import { useSessionFeed } from "../hooks/use-session-feed"
import { runWithReconnect } from "../utils/run-with-reconnect"
import {
  getPromptSearchState,
  SessionUiState,
  transitionSessionUi,
  type SessionUiEffect,
  type SessionUiEvent,
} from "./session-ui-state"
import { createPromptSearchController } from "./prompt-search-controller"

type QueueState = {
  steering: readonly QueueEntryInfo[]
  followUp: readonly QueueEntryInfo[]
}

export interface SessionController {
  client: ReturnType<typeof useClient>
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
  onSlashCommand: (cmd: string, args: string) => Effect.Effect<void, UiError>
  onRestoreQueue: () => void
  onComposerEvent: (event: ComposerEvent) => void
  closeOverlay: () => void
  onSessionTreeSelect: (sessionId: SessionId) => void
  onForkSelect: (messageId: MessageId) => void
  onPromptSearchEvent: (event: Extract<SessionUiEvent, { _tag: "PromptSearch" }>["event"]) => void
}

const SPINNER_FRAMES = ["·", "•", "*", "⁑", "⁂"]

const getTreeOverlay = (state: ReturnType<typeof SessionUiState.initial>["overlay"]) =>
  state._tag === "tree" ? state.tree : null

const pickPermissionDecision = (
  answers: readonly (readonly string[])[],
): { decision: "allow" | "deny"; persist: boolean } => {
  const selections = answers.flat().map((value) => value.trim().toLowerCase())
  if (selections.includes("always allow")) return { decision: "allow", persist: true }
  if (selections.includes("always deny")) return { decision: "deny", persist: true }
  if (selections.includes("allow")) return { decision: "allow", persist: false }
  if (selections.includes("deny")) return { decision: "deny", persist: false }
  return { decision: "deny", persist: false }
}

const pickPromptDecision = (
  answers: readonly (readonly string[])[],
): { decision: "yes" | "no" | "edit"; content?: string } => {
  const selections = answers.flat().map((value) => value.trim())
  const normalized = selections.map((value) => value.toLowerCase())
  if (normalized.includes("yes")) return { decision: "yes" }
  if (normalized.includes("edit")) return { decision: "edit" }
  if (normalized.includes("no")) return { decision: "no" }
  const content = selections[0]
  return {
    decision: "no",
    ...(content !== undefined && content.length > 0 ? { content } : {}),
  }
}

export function useSessionController(props: {
  sessionId: SessionId
  branchId: BranchId
  initialPrompt?: string
}): SessionController {
  const client = useClient()
  const command = useCommand()
  const router = useRouter()
  const { cast } = useRuntime(client.client)
  const { exit, handleEsc } = useExit()
  const quitChain = useKeyChain()
  const workspace = useWorkspace()
  const history = usePromptHistory()
  const tick = useSpinnerClock()
  const { getChildren } = useChildSessions(client)

  const [uiState, setUiState] = createSignal(SessionUiState.initial())
  const [composerState, setComposerState] = createSignal<ComposerState>(ComposerState.idle())
  const [interactionState, setInteractionState] = createSignal(ComposerInteractionState.initial())
  const [queueState, setQueueState] = createSignal<QueueState>({ steering: [], followUp: [] })
  const [elapsed, setElapsed] = createSignal(0)
  let activityStartTime = Date.now()

  const handleSessionUiEffect = (effect: SessionUiEffect) => {
    if (effect._tag === "RestoreComposer") {
      setInteractionState((current) =>
        transitionComposerInteraction(current, { _tag: "RestoreDraft", text: effect.text }),
      )
    }
  }

  const dispatchSessionUi = (event: SessionUiEvent) => {
    const result = transitionSessionUi(uiState(), event)
    setUiState(result.state)
    for (const effect of result.effects) handleSessionUiEffect(effect)
  }

  const handleComposerEffect = (effect: ReturnType<typeof transition>["effect"]) => {
    if (effect === undefined) return
    switch (effect._tag) {
      case "RespondPrompt":
        if (effect.kind === "questions") {
          cast(
            client.client.respondQuestions(effect.requestId, effect.answers).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  client.setError(formatError(error))
                }),
              ),
            ),
          )
          return
        }

        if (effect.kind === "permission") {
          const { decision, persist } = pickPermissionDecision(effect.answers)
          cast(
            client.client.respondPermission(effect.requestId, decision, persist).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  client.setError(formatError(error))
                }),
              ),
            ),
          )
          return
        }

        if (effect.kind === "handoff") {
          const { decision } = pickPromptDecision(effect.answers)
          const handoffDecision = decision === "yes" ? "confirm" : "reject"
          cast(
            Effect.gen(function* () {
              const result = yield* client.client.respondHandoff(effect.requestId, handoffDecision)
              if (result.childSessionId === undefined || result.childBranchId === undefined) return
              client.switchSession(result.childSessionId, result.childBranchId, "Handoff")
            }).pipe(
              Effect.catchEager((error: unknown) =>
                Effect.sync(() => {
                  client.setError(
                    typeof error === "object" && error !== null
                      ? formatError(error as UiError)
                      : String(error),
                  )
                }),
              ),
            ),
          )
          return
        }

        const { decision, content } = pickPromptDecision(effect.answers)
        cast(
          client.client.respondPrompt(effect.requestId, decision, content).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                client.setError(formatError(error))
              }),
            ),
          ),
        )
        return
    }
  }

  const onComposerEvent = (event: ComposerEvent) => {
    const result = transition(composerState(), event)
    setComposerState(result.state)
    handleComposerEffect(result.effect)
  }

  const onComposerInteraction = (event: ComposerInteractionEvent) => {
    setInteractionState((current) => transitionComposerInteraction(current, event))
  }

  const feed = useSessionFeed(
    () => props.sessionId,
    () => props.branchId,
    client,
    cast,
    {
      onComposerEvent,
      onBranchSwitch: (sessionId, branchId) => {
        router.navigateToSession(sessionId, branchId)
      },
    },
    props.initialPrompt,
  )

  const items = createMemo<SessionItem[]>(() => feed.items())
  const promptSearch = createPromptSearchController({
    state: () => getPromptSearchState(uiState()),
    entries: history.entries,
    draft: () => interactionState().draft,
    dispatch: (event, entries) =>
      dispatchSessionUi({
        _tag: "PromptSearch",
        event,
        entries,
      }),
  })

  createEffect(() => {
    void props.sessionId
    void props.branchId
    const generation = client.connectionGeneration()
    void generation
    if (!client.isActive()) return
    const fiber = client.client.runFork(
      runWithReconnect(
        () =>
          client.client
            .watchRuntime({
              sessionId: props.sessionId,
              branchId: props.branchId,
            })
            .pipe(
              Stream.runForEach((next) =>
                Effect.sync(() => {
                  client.setConnectionIssue(null)
                  setQueueState(next.queue)
                }),
              ),
            ),
        {
          onError: (error) => {
            client.setConnectionIssue(formatConnectionIssue(error))
          },
          waitForRetry: () => client.waitForTransportReady(),
        },
      ),
    )
    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(fiber))
    })
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
    activityStartTime = Date.now()
    setElapsed(0)

    if (nextActivity.phase === "idle") return

    const interval = setInterval(() => {
      setElapsed(Date.now() - activityStartTime)
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  const spinner = createMemo(() => {
    const index = tick() % SPINNER_FRAMES.length
    return SPINNER_FRAMES[index] ?? "·"
  })

  const phaseLabel = createMemo(() => {
    const nextActivity = activity()
    switch (nextActivity.phase) {
      case "idle":
        return nextActivity.turn > 0 ? "idle" : "ready"
      case "thinking":
        return "thinking"
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
          dispatchSessionUi({ _tag: "OpenTree", tree, sessions })
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
    dispatchSessionUi({ _tag: "OpenFork" })
  }

  const onRestoreQueue = () => {
    cast(
      client.drainQueuedMessages().pipe(
        Effect.tap(({ steering, followUp }) =>
          Effect.sync(() => {
            const all = [...steering, ...followUp]
            if (all.length === 0) return
            onComposerInteraction({
              _tag: "RestoreDraft",
              text: all.map((entry) => entry.content).join("\n"),
            })
            setQueueState({ steering: [], followUp: [] })
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

  const onSlashCommand = (cmd: string, args: string): Effect.Effect<void, UiError> =>
    executeSlashCommand(cmd, args, {
      openPalette: () => command.openPalette(),
      clearMessages: feed.clear,
      navigateToSessions: () => command.openPalette(),
      createBranch: client.createBranch().pipe(Effect.asVoid),
      openTree: openSessionTree,
      openFork: openForkPicker,
      toggleBypass: Effect.gen(function* () {
        const current = client.session()?.bypass ?? true
        yield* client.updateSessionBypass(!current)
      }),
      setReasoningLevel: (level) => client.updateSessionReasoningLevel(level),
      openPermissions: () => router.navigateToPermissions(),
      openAuth: () => router.navigateToAuth(),
      sendMessage: (content: string) => client.sendMessage(content),
      newSession: () =>
        client.client
          .createSession({
            cwd: workspace.cwd,
            bypass: client.session()?.bypass ?? true,
          })
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                client.switchSession(result.sessionId, result.branchId, result.name, result.bypass)
                router.navigateToSession(result.sessionId, result.branchId)
              }),
            ),
            Effect.asVoid,
            Effect.catchEager((error) => Effect.fail(ClientError(formatError(error)))),
          ),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.error !== undefined) client.setError(result.error)
        }),
      ),
      Effect.asVoid,
    )

  const onSessionTreeSelect = (sessionId: SessionId) => {
    const currentOverlay = uiState().overlay
    dispatchSessionUi({ _tag: "CloseOverlay" })
    if (currentOverlay._tag !== "tree") return

    const nextSession = currentOverlay.sessions.find((session) => session.id === sessionId)
    if (nextSession === undefined || nextSession.branchId === undefined) {
      client.setError("Session tree entry missing active branch")
      return
    }

    client.switchSession(
      nextSession.id,
      nextSession.branchId,
      nextSession.name ?? "Unnamed",
      nextSession.bypass,
    )
    router.navigateToSession(nextSession.id, nextSession.branchId)
  }

  const onForkSelect = (messageId: MessageId) => {
    dispatchSessionUi({ _tag: "CloseOverlay" })
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
      client.steer({ _tag: "Interject", message: content, agent: client.agent() })
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
      onComposerInteraction({ _tag: "ClearDraft" })
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
        client.steer({ _tag: "Cancel" })
        quitChain.reset()
        return true
      }

      handleQuitKey("escape")
      return true
    }

    if (event.ctrl === true && event.name === "c") {
      handleQuitKey("ctrl+c")
      return true
    }

    if (event.ctrl === true && event.name === "r") {
      promptSearch.open()
      quitChain.reset()
      return true
    }

    if (event.ctrl === true && event.name === "o") {
      dispatchSessionUi({ _tag: "ToggleTools" })
      return true
    }

    if (event.ctrl === true && event.shift === true && event.name === "m") {
      dispatchSessionUi({ _tag: "OpenMermaid" })
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
    onComposerEvent,
    closeOverlay: () => dispatchSessionUi({ _tag: "CloseOverlay" }),
    onSessionTreeSelect,
    onForkSelect,
    onPromptSearchEvent: (event) => promptSearch.onEvent(event),
  }
}
