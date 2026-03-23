/**
 * Session route - message list, input, streaming
 */

import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Effect } from "effect"
import { type SessionInfo, type SessionTreeNode, useClient } from "../client/index"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids.js"
import { MessageList, type SessionItem } from "../components/message-list"
import { Input } from "../components/input"
import { useTheme, buildSyntaxStyle } from "../theme/index"
import { useCommand } from "../command/index"
import { useRouter } from "../router/index"
import { executeSlashCommand } from "../commands/slash-commands"
import { useRuntime } from "../hooks/use-runtime"
import {
  InputState,
  transition,
  type InputEvent,
  type InputEffect,
} from "../components/input-state"
import { ClientError, formatError, type UiError } from "../utils/format-error"
import { useExit } from "../hooks/use-exit"
import { SessionTree } from "../components/session-tree"
import { MessagePicker } from "../components/message-picker"
import { MermaidViewer, collectDiagrams } from "../components/mermaid-viewer"
import { TaskWidget } from "../components/task-widget"
import { QueueWidget } from "../components/queue-widget"
import { useWorkspace } from "../workspace/index"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { useChildSessions } from "../hooks/use-child-sessions"
import {
  BorderedInput,
  formatCwdGit,
  formatElapsed,
  type BorderLabelItem,
} from "../components/bordered-input"
import { buildTopRightLabels } from "../utils/session-labels"
import { useSessionFeed } from "../hooks/use-session-feed"
import { useKeyChain } from "../hooks/use-key-chain"
import { PromptSearchPalette } from "../components/prompt-search-palette"

export interface SessionProps {
  sessionId: SessionId
  branchId: BranchId
  initialPrompt?: string
  debugMode?: boolean
}

type QueueState = {
  steering: readonly string[]
  followUp: readonly string[]
}

type OverlayState =
  | null
  | { _tag: "tree"; tree: SessionTreeNode; sessions: readonly SessionInfo[] }
  | { _tag: "fork" }
  | { _tag: "mermaid" }
  | { _tag: "prompt-search" }

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const router = useRouter()
  const { cast } = useRuntime(client.client.services)
  const { exit, handleEsc } = useExit()
  const quitChain = useKeyChain()
  const workspace = useWorkspace()
  const tick = useSpinnerClock()
  const { getChildren } = useChildSessions(client)

  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))

  const [toolsExpanded, setToolsExpanded] = createSignal(false)
  const [inputState, setInputState] = createSignal<InputState>(InputState.normal())
  const [overlay, setOverlay] = createSignal<OverlayState>(null)
  const [queueState, setQueueState] = createSignal<QueueState>({ steering: [], followUp: [] })
  const [composerText, setComposerText] = createSignal("")
  const [restoreTextRequest, setRestoreTextRequest] = createSignal<
    { token: number; text: string } | undefined
  >(undefined)
  const promptSearchOpen = () => overlay()?._tag === "prompt-search"
  const closePromptSearch = () => {
    setOverlay(null)
    setRestoreTextRequest({ token: Date.now(), text: "" })
  }

  const syncQueueState = () =>
    cast(
      client.getQueuedMessages().pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            setQueueState(next)
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )

  // Handle input state transitions
  const handleInputEvent = (event: InputEvent) => {
    const result = transition(inputState(), event)
    setInputState(result.state)
    if (result.effect !== undefined) {
      handleInputEffect(result.effect)
    }
  }

  // ── Session feed — owns messages, events, subscription lifecycle ──
  const feed = useSessionFeed(
    () => props.sessionId,
    () => props.branchId,
    client,
    cast,
    {
      onInputEvent: handleInputEvent,
      onBranchSwitch: (sessionId, branchId) => {
        router.navigateToSession(sessionId, branchId)
      },
    },
    props.initialPrompt,
  )

  const items = createMemo<SessionItem[]>(() => feed.items())

  createEffect(() => {
    const sessionId = props.sessionId
    const branchId = props.branchId
    void sessionId
    void branchId
    syncQueueState()
  })

  createEffect(() => {
    const queue = queueState()
    const shouldPoll =
      client.isStreaming() || queue.steering.length > 0 || queue.followUp.length > 0
    if (!shouldPoll) return

    const interval = setInterval(() => {
      syncQueueState()
    }, 250)

    onCleanup(() => clearInterval(interval))
  })

  // ── Elapsed timer ──
  const [elapsed, setElapsed] = createSignal(0)
  let activityStartTime = Date.now()

  createEffect(() => {
    const a = activity()
    activityStartTime = Date.now()
    setElapsed(0)

    if (a.phase === "idle") return

    const interval = setInterval(() => {
      setElapsed(Date.now() - activityStartTime)
    }, 1000)
    onCleanup(() => clearInterval(interval))
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
          setOverlay({ _tag: "tree", tree, sessions })
        })
      }).pipe(
        Effect.catchEager((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
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
    setOverlay({ _tag: "fork" })
  }

  useKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) return

    if (overlay() !== null) return

    const clearComposer = () => {
      setRestoreTextRequest({ token: Date.now(), text: "" })
    }

    const handleQuitKey = (chainId: string) => {
      if (composerText().length > 0) {
        quitChain.trigger(chainId, {
          first: clearComposer,
          second: exit,
        })
        return
      }

      quitChain.trigger(chainId, {
        first: () => {
          handleEsc()
        },
        second: exit,
      })
    }

    // ESC: cancel if streaming, double-tap to quit when idle
    if (e.name === "escape") {
      if (promptSearchOpen()) {
        setOverlay(null)
        quitChain.reset()
        return
      }

      if (command.paletteOpen()) {
        command.closePalette()
        quitChain.reset()
        return
      }

      if (client.isStreaming()) {
        client.steer({ _tag: "Cancel" })
        quitChain.reset()
        return
      }

      handleQuitKey("escape")
      return
    }

    // Ctrl+C: clear composer first, then quit
    if (e.ctrl === true && e.name === "c") {
      handleQuitKey("ctrl+c")
      return
    }

    if (e.ctrl === true && e.name === "r") {
      setOverlay({ _tag: "prompt-search" })
      quitChain.reset()
      return
    }

    // Ctrl+O: toggle tool output expansion
    if (e.ctrl === true && e.name === "o") {
      setToolsExpanded((prev) => !prev)
      return
    }

    // Ctrl+Shift+M: open mermaid viewer
    if (e.ctrl === true && e.shift === true && e.name === "m") {
      setOverlay({ _tag: "mermaid" })
      return
    }
  })

  const handleSubmit = (content: string, mode?: "queue" | "interject") => {
    if (mode === "interject" && client.isStreaming()) {
      client.steer({ _tag: "Interject", message: content, agent: client.agent() })
      setTimeout(syncQueueState, 0)
      return
    }

    if (client.isStreaming()) {
      client.sendMessage(content)
      setTimeout(syncQueueState, 0)
      return
    }

    client.sendMessage(content)
  }

  const restoreQueuedMessages = () => {
    cast(
      client.drainQueuedMessages().pipe(
        Effect.tap(({ steering, followUp }) =>
          Effect.sync(() => {
            const all = [...steering, ...followUp]
            if (all.length === 0) return
            setRestoreTextRequest({
              token: Date.now(),
              text: all.join("\n"),
            })
            setQueueState({ steering: [], followUp: [] })
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  }

  // Handle input effects (side effects from state transitions)
  const handleInputEffect = (effect: InputEffect) => {
    switch (effect._tag) {
      case "ClearInput":
        // Input component handles this internally
        break
      case "RespondPrompt":
        if (effect.kind === "questions") {
          cast(
            client.client.respondQuestions(effect.requestId, effect.answers).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(formatError(err))
                }),
              ),
            ),
          )
        } else if (effect.kind === "permission") {
          const { decision, persist } = pickPermissionDecision(effect.answers)
          cast(
            client.client.respondPermission(effect.requestId, decision, persist).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(formatError(err))
                }),
              ),
            ),
          )
        } else if (effect.kind === "handoff") {
          const { decision } = pickPromptDecision(effect.answers)
          const handoffDecision = decision === "yes" ? "confirm" : "reject"
          cast(
            Effect.gen(function* () {
              const result = yield* client.client.respondHandoff(effect.requestId, handoffDecision)
              const childId = result.childSessionId
              const childBranchId = result.childBranchId
              if (childId === undefined || childBranchId === undefined) return
              client.switchSession(childId, childBranchId, "Handoff")
            }).pipe(
              Effect.catchEager((err: unknown) =>
                Effect.sync(() => {
                  client.setError(
                    typeof err === "object" && err !== null
                      ? formatError(err as UiError)
                      : String(err),
                  )
                }),
              ),
            ),
          )
        } else {
          const { decision, content } = pickPromptDecision(effect.answers)
          cast(
            client.client.respondPrompt(effect.requestId, decision, content).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(formatError(err))
                }),
              ),
            ),
          )
        }
        break
    }
  }

  const handleSlashCommand = (cmd: string, args: string): Effect.Effect<void, UiError> =>
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
          if (result.error !== undefined) {
            client.setError(result.error)
          }
        }),
      ),
      Effect.asVoid,
    )

  const handleSessionTreeSelect = (sessionId: SessionId) => {
    const current = overlay()
    setOverlay(null)
    if (current?._tag !== "tree") return
    const next = current.sessions.find((session) => session.id === sessionId)
    const branchId = next?.branchId
    if (next === undefined || branchId === undefined) {
      client.setError("Session tree entry missing active branch")
      return
    }
    client.switchSession(next.id, branchId, next.name ?? "Unnamed", next.bypass)
    router.navigateToSession(next.id, branchId)
  }

  const handleForkSelect = (messageId: MessageId) => {
    setOverlay(null)
    cast(
      client.forkBranch(messageId).pipe(
        Effect.tap((branchId) =>
          Effect.sync(() => {
            client.switchBranch(branchId)
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  }

  const overlayTree = () => {
    const current = overlay()
    return current?._tag === "tree" ? current.tree : null
  }

  const SPINNER_FRAMES = ["·", "•", "*", "⁑", "⁂"]

  const activity = () => {
    if (!client.isStreaming()) return { phase: "idle" as const, turn: feed.turnCount() }
    const tool = feed.activeTool()
    if (tool !== undefined)
      return { phase: "tool" as const, turn: feed.turnCount(), toolInfo: tool }
    return { phase: "thinking" as const, turn: feed.turnCount() }
  }

  const spinner = createMemo((): string => {
    const idx = tick() % SPINNER_FRAMES.length
    return SPINNER_FRAMES[idx] ?? "·"
  })

  const phaseLabel = createMemo(() => {
    const a = activity()
    switch (a.phase) {
      case "thinking":
        return "thinking"
      case "tool":
        return a.toolInfo ?? "working"
      case "idle":
        return ""
    }
  })

  const borderColor = () => {
    if (client.isError()) return theme.error
    if (props.debugMode === true) return theme.warning
    if (client.isStreaming()) return theme.borderActive
    return theme.border
  }

  const topLeftLabels = (): BorderLabelItem[] => {
    const c = client.cost()
    return c > 0 ? [{ text: `$${c.toFixed(2)}`, color: theme.textMuted }] : []
  }

  const topRightLabels = (): BorderLabelItem[] =>
    buildTopRightLabels(
      client.agent(),
      client.session()?.reasoningLevel,
      client.latestInputTokens(),
      client.modelInfo()?.contextLength,
      theme,
      { debugMode: props.debugMode },
    )

  const bottomLeftLabels = (): BorderLabelItem[] => {
    const a = activity()
    if (a.phase === "idle") return []
    const items: BorderLabelItem[] = [
      { text: spinner(), color: theme.textMuted },
      { text: `turn ${a.turn}`, color: theme.textMuted },
      { text: phaseLabel(), color: theme.info },
    ]
    if (elapsed() >= 1000) {
      items.push({ text: formatElapsed(elapsed()), color: theme.textMuted })
    }
    return items
  }

  const bottomRightLabels = (): BorderLabelItem[] => {
    const label = formatCwdGit(workspace.cwd, workspace.gitRoot(), workspace.gitStatus()?.branch)
    return [{ text: label, color: theme.textMuted }]
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Messages */}
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <box flexDirection="column">
          <MessageList
            items={items()}
            toolsExpanded={toolsExpanded()}
            syntaxStyle={syntaxStyle}
            streaming={client.isStreaming()}
            getChildSessions={getChildren}
          />

          <TaskWidget sessionId={props.sessionId} branchId={props.branchId} />
          <QueueWidget
            queuedMessages={queueState().followUp.map((content) => ({ content, createdAt: 0 }))}
            steerMessages={queueState().steering.map((content) => ({ content, createdAt: 0 }))}
          />
        </box>
      </scrollbox>

      {/* Bordered input */}
      <BorderedInput
        topLeft={topLeftLabels()}
        topRight={topRightLabels()}
        bottomLeft={bottomLeftLabels()}
        bottomRight={bottomRightLabels()}
        borderColor={borderColor()}
      >
        <Input
          onSubmit={handleSubmit}
          onSlashCommand={handleSlashCommand}
          clearMessages={feed.clear}
          onRestoreQueue={restoreQueuedMessages}
          onTextChange={setComposerText}
          restoreTextRequest={restoreTextRequest()}
          inputState={inputState()}
          onInputEvent={handleInputEvent}
          onInputEffect={handleInputEffect}
        >
          <Input.Autocomplete />
        </Input>
      </BorderedInput>

      <SessionTree
        open={overlay()?._tag === "tree"}
        tree={overlayTree()}
        currentSessionId={props.sessionId}
        onSelect={handleSessionTreeSelect}
        onClose={() => setOverlay(null)}
      />

      <MessagePicker
        open={overlay()?._tag === "fork"}
        messages={feed.messages()}
        onSelect={handleForkSelect}
        onClose={() => setOverlay(null)}
      />

      <MermaidViewer
        open={overlay()?._tag === "mermaid"}
        diagrams={overlay()?._tag === "mermaid" ? collectDiagrams(feed.messages()) : []}
        onClose={() => setOverlay(null)}
      />

      <PromptSearchPalette
        open={promptSearchOpen()}
        onClose={closePromptSearch}
        onSelect={(prompt) => {
          setRestoreTextRequest({ token: Date.now(), text: prompt })
          setOverlay(null)
        }}
      />
    </box>
  )
}

const pickPermissionDecision = (
  answers: readonly (readonly string[])[],
): { decision: "allow" | "deny"; persist: boolean } => {
  const selections = answers.flat().map((value) => value.trim().toLowerCase())
  if (selections.includes("always allow")) {
    return { decision: "allow", persist: true }
  }
  if (selections.includes("always deny")) {
    return { decision: "deny", persist: true }
  }
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
    content: content !== undefined && content.length > 0 ? content : undefined,
  }
}
