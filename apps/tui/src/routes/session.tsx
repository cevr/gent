/**
 * Session route - message list, input, streaming
 */

import { createSignal, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import { Effect } from "effect"
import {
  extractText,
  extractReasoning,
  extractImages,
  buildToolResultMap,
  extractToolCallsWithResults,
  type MessageInfoReadonly,
  type BranchTreeNode,
  useClient,
} from "../client/index"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids.js"
import { MessageList, type Message, type SessionItem } from "../components/message-list"
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
import { formatError, type UiError } from "../utils/format-error"
import { useExit } from "../hooks/use-exit"
import { BranchTree } from "../components/branch-tree"
import { MessagePicker } from "../components/message-picker"
import type { SessionEvent } from "../components/session-event-indicator"
import { formatToolInput } from "../components/message-list-utils"
import { MermaidViewer, collectDiagrams } from "../components/mermaid-viewer"
import { TaskWidget } from "../components/task-widget"
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
import { clientLog } from "../utils/client-logger"

export interface SessionProps {
  sessionId: SessionId
  branchId: BranchId
  initialPrompt?: string
}

type OverlayState =
  | null
  | { _tag: "tree"; nodes: BranchTreeNode[] }
  | { _tag: "fork" }
  | { _tag: "mermaid" }

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const router = useRouter()
  const { cast } = useRuntime(client.client.services)
  const { exit, handleEsc } = useExit()
  const workspace = useWorkspace()
  const tick = useSpinnerClock()
  const { getChildren } = useChildSessions(client)

  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))

  const [store, setStore] = createStore<{ messages: Message[]; events: SessionEvent[] }>({
    messages: [],
    events: [],
  })
  const [toolsExpanded, setToolsExpanded] = createSignal(false)
  const [inputState, setInputState] = createSignal<InputState>(InputState.normal())
  const [overlay, setOverlay] = createSignal<OverlayState>(null)
  const [turnCount, setTurnCount] = createSignal(0)
  const [activeTool, setActiveTool] = createSignal<string | undefined>(undefined)
  let initialPromptSent = false
  let eventSeq = 0

  const items = createMemo((): SessionItem[] => {
    const combined: SessionItem[] = [...store.messages, ...store.events]
    return combined.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (a._tag === "event" && b._tag === "event") return a.seq - b.seq
      if (a._tag === b._tag) return 0
      return a._tag === "message" ? -1 : 1
    })
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

  // Build messages from raw messages
  const buildMessages = (msgs: readonly MessageInfoReadonly[]): Message[] => {
    const resultMap = buildToolResultMap(msgs)
    const filteredMsgs = msgs.filter((m) => m.role !== "tool")

    return filteredMsgs.map((m) => {
      const toolCalls = extractToolCallsWithResults(m.parts, resultMap)

      return {
        _tag: "message",
        id: m.id,
        role: m.role,
        kind: m.kind ?? "regular",
        content: extractText(m.parts),
        reasoning: extractReasoning(m.parts),
        images: extractImages(m.parts),
        createdAt: m.createdAt,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      }
    })
  }

  const loadMessages = (branchId: BranchId) => {
    cast(
      client.client.listMessages(branchId).pipe(
        Effect.map((msgs) => buildMessages(msgs)),
        Effect.tap((msgs) =>
          Effect.sync(() => {
            setStore("messages", msgs)
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

  const sendInitialPrompt = () => {
    if (props.initialPrompt === undefined || props.initialPrompt === "" || initialPromptSent) return
    initialPromptSent = true
    clientLog.info("sendInitialPrompt", { sessionId: props.sessionId, branchId: props.branchId })
    cast(
      client.client
        .sendMessage({
          sessionId: props.sessionId,
          branchId: props.branchId,
          content: props.initialPrompt,
        })
        .pipe(
          Effect.tapError((err) =>
            Effect.sync(() => {
              client.setError(formatError(err))
            }),
          ),
        ),
    )
  }

  // Narrow reactive dependency: only re-run when session identity changes,
  // not on every machine state mutation (UpdateBypass, UpdateReasoningLevel, etc.)
  const activeSessionKey = createMemo(() => {
    const s = client.session()
    return s === null ? null : `${s.sessionId}:${s.branchId}`
  })
  const routeKey = () => `${props.sessionId}:${props.branchId}`

  // Load messages + subscribe to events when session becomes active
  createEffect(
    on([activeSessionKey, routeKey], ([active, route]) => {
      if (active === null || active !== route) return

      clientLog.info("session.activate", { sessionId: props.sessionId, branchId: props.branchId })
      loadMessages(props.branchId)
      const unsubscribe = client.subscribeEvents((event) => {
        if (event._tag === "MessageReceived") {
          loadMessages(props.branchId)
        } else if (event._tag === "BranchSwitched") {
          if (event.toBranchId !== props.branchId) {
            setStore({ messages: [], events: [] })
            router.navigateToSession(event.sessionId, event.toBranchId)
          }
        } else if (event._tag === "StreamStarted") {
          setTurnCount((n) => n + 1)
          setActiveTool(undefined)
          setStore(
            produce((draft) => {
              draft.messages.push({
                _tag: "message",
                id: crypto.randomUUID(),
                role: "assistant",
                kind: "regular",
                content: "",
                reasoning: "",
                images: [],
                createdAt: Date.now(),
                toolCalls: undefined,
              })
            }),
          )
        } else if (event._tag === "StreamChunk") {
          setStore(
            produce((draft) => {
              const last = draft.messages[draft.messages.length - 1]
              if (last !== undefined && last.role === "assistant") {
                last.content += event.chunk
              } else {
                draft.messages.push({
                  _tag: "message",
                  id: crypto.randomUUID(),
                  role: "assistant",
                  kind: "regular",
                  content: event.chunk,
                  reasoning: "",
                  images: [],
                  createdAt: Date.now(),
                  toolCalls: undefined,
                })
              }
            }),
          )
        } else if (event._tag === "TurnCompleted") {
          // Server is source of truth for turn completion/interruption
          const durationSeconds = Math.round(event.durationMs / 1000)
          if (event.interrupted === true) {
            setStore(
              produce((draft) => {
                draft.events.push({
                  _tag: "event",
                  kind: "interruption",
                  createdAt: Date.now(),
                  seq: eventSeq++,
                })
              }),
            )
          } else if (durationSeconds > 0) {
            setStore(
              produce((draft) => {
                draft.events.push({
                  _tag: "event",
                  kind: "turn-ended",
                  durationSeconds,
                  createdAt: Date.now(),
                  seq: eventSeq++,
                })
              }),
            )
          }
        } else if (event._tag === "ToolCallStarted") {
          const inputSummary = formatToolInput(event.toolName, event.input)
          setActiveTool(
            inputSummary.length > 0 ? `${event.toolName}(${inputSummary})` : event.toolName,
          )
          setStore(
            produce((draft) => {
              const last = draft.messages[draft.messages.length - 1]
              if (last !== undefined && last.role === "assistant") {
                if (last.toolCalls === undefined) last.toolCalls = []
                last.toolCalls.push({
                  id: event.toolCallId,
                  toolName: event.toolName,
                  status: "running" as const,
                  input: event.input,
                  summary: undefined,
                  output: undefined,
                })
              }
            }),
          )
        } else if (
          event._tag === "ToolCallCompleted" ||
          event._tag === "ToolCallSucceeded" ||
          event._tag === "ToolCallFailed"
        ) {
          const isError =
            event._tag === "ToolCallFailed" || (event._tag === "ToolCallCompleted" && event.isError)
          setActiveTool(undefined)
          setStore(
            produce((draft) => {
              const last = draft.messages[draft.messages.length - 1]
              if (last !== undefined && last.role === "assistant" && last.toolCalls !== undefined) {
                const tc = last.toolCalls.find((t) => t.id === event.toolCallId)
                if (tc !== undefined) {
                  tc.status = isError ? "error" : "completed"
                  tc.summary = event.summary
                  tc.output = event.output
                }
              }
            }),
          )
        } else if (event._tag === "QuestionsAsked") {
          handleInputEvent({ _tag: "QuestionsAsked", event })
        } else if (event._tag === "PermissionRequested") {
          handleInputEvent({ _tag: "PermissionRequested", event })
        } else if (event._tag === "PromptPresented") {
          handleInputEvent({ _tag: "PromptPresented", event })
        } else if (event._tag === "HandoffPresented") {
          handleInputEvent({ _tag: "HandoffPresented", event })
        } else if (event._tag === "ErrorOccurred") {
          clientLog.error("session.errorEvent", { error: event.error, eventSeq })
          setStore(
            produce((draft) => {
              draft.events.push({
                _tag: "event",
                kind: "error",
                error: event.error,
                createdAt: Date.now(),
                seq: eventSeq++,
              })
            }),
          )
        }
        // Note: agent state (status, cost, error) is updated by ClientProvider
      })

      sendInitialPrompt()

      onCleanup(unsubscribe)
    }),
  )

  // Clear messages handler for /clear command
  const clearMessages = () => {
    setStore({ messages: [], events: [] })
  }

  const openBranchTree = () => {
    cast(
      client.getBranchTree().pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setOverlay({ _tag: "tree", nodes: [...tree] })
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

  const openForkPicker = () => {
    if (store.messages.length === 0) {
      client.setError("No messages to fork")
      return
    }
    setOverlay({ _tag: "fork" })
  }

  useKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) return

    if (overlay() !== null) return

    // ESC: cancel if streaming, double-tap to quit when idle
    if (e.name === "escape") {
      if (command.paletteOpen()) {
        command.closePalette()
        return
      }

      if (client.isStreaming()) {
        client.steer({ _tag: "Cancel" })
        return
      }

      handleEsc()
      return
    }

    // Ctrl+C: always quit immediately
    if (e.ctrl === true && e.name === "c") {
      exit()
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
      client.steer({ _tag: "Interject", message: content })
      return
    }

    client.sendMessage(content)
  }

  // Handle input state transitions
  const handleInputEvent = (event: InputEvent) => {
    const result = transition(inputState(), event)
    setInputState(result.state)
    if (result.effect !== undefined) {
      handleInputEffect(result.effect)
    }
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
      clearMessages,
      navigateToSessions: () => command.openPalette(),
      createBranch: client.createBranch().pipe(Effect.asVoid),
      openTree: openBranchTree,
      openFork: openForkPicker,
      toggleBypass: Effect.gen(function* () {
        const current = client.session()?.bypass ?? true
        yield* client.updateSessionBypass(!current)
      }),
      setReasoningLevel: (level) => client.updateSessionReasoningLevel(level),
      openPermissions: () => router.navigateToPermissions(),
      openAuth: () => router.navigateToAuth(),
      sendMessage: (content: string) => client.sendMessage(content),
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

  const handleBranchSelect = (branchId: BranchId) => {
    setOverlay(null)
    client.switchBranch(branchId)
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
    return current?._tag === "tree" ? current.nodes : []
  }

  const SPINNER_FRAMES = ["·", "•", "*", "⁑", "⁂"]

  const activity = () => {
    if (!client.isStreaming()) return { phase: "idle" as const, turn: turnCount() }
    const tool = activeTool()
    if (tool !== undefined) return { phase: "tool" as const, turn: turnCount(), toolInfo: tool }
    return { phase: "thinking" as const, turn: turnCount() }
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

  const borderColor = () =>
    client.isError() ? theme.error : client.isStreaming() ? theme.borderActive : theme.border

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
      <MessageList
        items={items()}
        toolsExpanded={toolsExpanded()}
        syntaxStyle={syntaxStyle}
        streaming={client.isStreaming()}
        getChildSessions={getChildren}
      />

      {/* Task widget */}
      <TaskWidget sessionId={props.sessionId} branchId={props.branchId} />

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
          clearMessages={clearMessages}
          inputState={inputState()}
          onInputEvent={handleInputEvent}
          onInputEffect={handleInputEffect}
        >
          <Input.Autocomplete />
        </Input>
      </BorderedInput>

      <BranchTree
        open={overlay()?._tag === "tree"}
        tree={overlayTree()}
        activeBranchId={client.session()?.branchId}
        onSelect={handleBranchSelect}
        onClose={() => setOverlay(null)}
      />

      <MessagePicker
        open={overlay()?._tag === "fork"}
        messages={store.messages}
        onSelect={handleForkSelect}
        onClose={() => setOverlay(null)}
      />

      <MermaidViewer
        open={overlay()?._tag === "mermaid"}
        diagrams={overlay()?._tag === "mermaid" ? collectDiagrams(store.messages) : []}
        onClose={() => setOverlay(null)}
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
