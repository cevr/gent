/**
 * Session route - message list, input, streaming
 */

import { createSignal, createEffect, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import {
  extractText,
  extractImages,
  buildToolResultMap,
  extractToolCallsWithResults,
  type MessageInfoReadonly,
  type BranchTreeNode,
} from "../client.js"
import { StatusBar } from "../components/status-bar"
import { MessageList, type Message, type SessionItem } from "../components/message-list"
import { Indicators, type Indicator } from "../components/indicators"
import { Input } from "../components/input"
import { useTheme } from "../theme/index"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
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
import { BranchTree } from "../components/branch-tree"
import { MessagePicker } from "../components/message-picker"
import type { SessionEvent } from "../components/session-event-indicator"
import type { QuestionsAsked, PermissionRequested, PlanPresented, ModelId } from "@gent/core"
import * as State from "../state"

export interface SessionProps {
  sessionId: string
  branchId: string
  initialPrompt?: string
}

export function Session(props: SessionProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const router = useRouter()
  const { cast } = useRuntime(client.client.runtime)

  const [messages, setMessages] = createSignal<Message[]>([])
  const [events, setEvents] = createSignal<SessionEvent[]>([])
  const [elapsed, setElapsed] = createSignal(0)
  const [toolsExpanded, setToolsExpanded] = createSignal(false)
  const [inputState, setInputState] = createSignal<InputState>(InputState.normal())
  const [treeOpen, setTreeOpen] = createSignal(false)
  const [treeNodes, setTreeNodes] = createSignal<BranchTreeNode[]>([])
  const [forkOpen, setForkOpen] = createSignal(false)
  const [compacting, setCompacting] = createSignal(false)
  const [modelToast, setModelToast] = createSignal<string | null>(null)
  let initialPromptSent = false
  let modelToastTimer: ReturnType<typeof setTimeout> | null = null
  let eventSeq = 0

  const COMPACTION_MIN_MS = 600
  let compactionStartedAt: number | null = null
  let compactionTimer: ReturnType<typeof setTimeout> | null = null

  const startCompaction = () => {
    compactionStartedAt = Date.now()
    if (compactionTimer) {
      clearTimeout(compactionTimer)
      compactionTimer = null
    }
    setCompacting(true)
  }

  const stopCompaction = () => {
    if (!compacting()) {
      compactionStartedAt = null
      return
    }

    const startedAt = compactionStartedAt ?? Date.now()
    const elapsedMs = Date.now() - startedAt
    const remainingMs = COMPACTION_MIN_MS - elapsedMs

    if (remainingMs <= 0) {
      setCompacting(false)
      compactionStartedAt = null
      return
    }

    if (compactionTimer) {
      clearTimeout(compactionTimer)
    }
    compactionTimer = setTimeout(() => {
      setCompacting(false)
      compactionStartedAt = null
      compactionTimer = null
    }, remainingMs)
  }

  // Derived - no separate signal needed
  const hasMessages = () => messages().length > 0

  const items = (): SessionItem[] => {
    const combined: SessionItem[] = [...messages(), ...events()]
    return combined.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (a._tag === "event" && b._tag === "event") return a.seq - b.seq
      if (a._tag === b._tag) return 0
      return a._tag === "message" ? -1 : 1
    })
  }

  // Track elapsed time while streaming
  let elapsedInterval: ReturnType<typeof setInterval> | null = null

  createEffect(() => {
    if (client.isStreaming()) {
      setElapsed(0)
      elapsedInterval = setInterval(() => {
        setElapsed((e) => e + 1)
      }, 1000)
    } else {
      if (elapsedInterval) {
        clearInterval(elapsedInterval)
        elapsedInterval = null
      }
    }
  })

  onCleanup(() => {
    if (elapsedInterval) clearInterval(elapsedInterval)
    if (compactionTimer) clearTimeout(compactionTimer)
    if (modelToastTimer) clearTimeout(modelToastTimer)
  })

  // Cycle through current-gen models with Ctrl+P
  const cycleModel = () => {
    const currentGenModels = State.currentGenModels()
    if (currentGenModels.length === 0) return

    const currentId = State.currentModel()
    const currentIdx = currentGenModels.findIndex((m) => m.id === currentId)
    const nextIdx = (currentIdx + 1) % currentGenModels.length
    const nextModel = currentGenModels[nextIdx]

    if (nextModel) {
      State.setModel(nextModel.id as ModelId)

      // Show toast notification
      if (modelToastTimer) clearTimeout(modelToastTimer)
      setModelToast(`${nextModel.name}`)
      modelToastTimer = setTimeout(() => {
        setModelToast(null)
        modelToastTimer = null
      }, 2000)
    }
  }

  const indicator = (): Indicator | null => {
    const error = client.error()
    if (error) return { _tag: "error", message: error }
    if (compacting()) return { _tag: "compacting" }
    if (client.isStreaming()) return { _tag: "thinking" }
    const toast = modelToast()
    if (toast) return { _tag: "toast", message: `Model: ${toast}` }
    return null
  }

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
        images: extractImages(m.parts),
        createdAt: m.createdAt,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      }
    })
  }

  // Load messages when session becomes active
  createEffect(() => {
    if (!client.isActive()) return

    cast(
      client.listMessages().pipe(
        Effect.map((msgs) => buildMessages(msgs)),
        Effect.tap((msgs) =>
          Effect.sync(() => {
            setMessages(msgs)
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  })

  const sendInitialPrompt = () => {
    if (!props.initialPrompt || initialPromptSent) return
    initialPromptSent = true
    cast(
      client.client
        .sendMessage({
          sessionId: props.sessionId,
          branchId: props.branchId,
          content: props.initialPrompt,
          mode: "plan",
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

  // Subscribe to agent events for message updates
  createEffect(() => {
    if (!client.isActive()) return

    const unsubscribe = client.subscribeEvents((event) => {
      if (event._tag === "MessageReceived") {
        cast(
          client.listMessages().pipe(
            Effect.map((msgs) => buildMessages(msgs)),
            Effect.tap((msgs) =>
              Effect.sync(() => {
                setMessages(msgs)
              }),
            ),
            Effect.catchAll((err) =>
              Effect.sync(() => {
                client.setError(formatError(err))
              }),
            ),
          ),
        )
      } else if (event._tag === "StreamStarted") {
        setMessages((prev) => [
          ...prev,
          {
            _tag: "message",
            id: crypto.randomUUID(),
            role: "assistant",
            kind: "regular",
            content: "",
            images: [],
            createdAt: Date.now(),
            toolCalls: undefined,
          },
        ])
      } else if (event._tag === "StreamChunk") {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, content: last.content + event.chunk }]
          }
          return [
            ...prev,
            {
              _tag: "message",
              id: crypto.randomUUID(),
              role: "assistant",
              kind: "regular",
              content: event.chunk,
              images: [],
              createdAt: Date.now(),
              toolCalls: undefined,
            },
          ]
        })
      } else if (event._tag === "StreamEnded") {
        const thinkTime = elapsed()
        const interrupted = event.interrupted === true
        if (thinkTime > 0) {
          setEvents((prev) => [
            ...prev,
            {
              _tag: "event",
              kind: "turn-ended",
              durationSeconds: thinkTime,
              createdAt: Date.now(),
              seq: eventSeq++,
            },
          ])
        }
        if (interrupted) {
          setEvents((prev) => [
            ...prev,
            {
              _tag: "event",
              kind: "interruption",
              createdAt: Date.now(),
              seq: eventSeq++,
            },
          ])
        }
      } else if (event._tag === "ToolCallStarted") {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === "assistant") {
            const toolCalls = last.toolCalls ?? []
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                toolCalls: [
                  ...toolCalls,
                  {
                    id: event.toolCallId,
                    toolName: event.toolName,
                    status: "running" as const,
                    input: event.input,
                    summary: undefined,
                    output: undefined,
                  },
                ],
              },
            ]
          }
          return prev
        })
      } else if (event._tag === "ToolCallCompleted") {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === "assistant" && last.toolCalls) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                toolCalls: last.toolCalls.map((tc) =>
                  tc.id === event.toolCallId
                    ? {
                        ...tc,
                        status: event.isError ? ("error" as const) : ("completed" as const),
                        summary: event.summary,
                        output: event.output,
                      }
                    : tc,
                ),
              },
            ]
          }
          return prev
        })
      } else if (event._tag === "CompactionStarted") {
        startCompaction()
      } else if (event._tag === "CompactionCompleted") {
        stopCompaction()
        setEvents((prev) => [
          ...prev,
          {
            _tag: "event",
            kind: "compaction",
            createdAt: Date.now(),
            seq: eventSeq++,
          },
        ])
      } else if (event._tag === "QuestionsAsked") {
        // Handle agent asking questions - transition to prompt state
        handleInputEvent({ _tag: "QuestionsAsked", event: event as typeof QuestionsAsked.Type })
      } else if (event._tag === "PermissionRequested") {
        handleInputEvent({
          _tag: "PermissionRequested",
          event: event as typeof PermissionRequested.Type,
        })
      } else if (event._tag === "PlanPresented") {
        handleInputEvent({ _tag: "PlanPresented", event: event as typeof PlanPresented.Type })
      }
      // Note: agent state (mode, status, cost, error) is updated by ClientProvider
    })

    sendInitialPrompt()

    onCleanup(unsubscribe)
  })

  const exit = () => {
    renderer.destroy()
    process.exit(0)
  }

  // Clear messages handler for /clear command
  const clearMessages = () => {
    setMessages([])
    setEvents([])
  }

  const openBranchTree = () => {
    cast(
      client.getBranchTree().pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setTreeNodes([...tree])
            setTreeOpen(true)
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  }

  const openForkPicker = () => {
    if (messages().length === 0) {
      client.setError("No messages to fork")
      return
    }
    setForkOpen(true)
  }

  // Track pending ESC for double-tap quit
  let lastEscTime = 0
  const ESC_DOUBLE_TAP_MS = 500

  useKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) return

    if (treeOpen() || forkOpen()) return

    // ESC: cancel if streaming, double-tap to quit when idle
    if (e.name === "escape") {
      if (command.paletteOpen()) {
        command.closePalette()
        return
      }

      if (client.isStreaming()) {
        client.steer({ _tag: "Cancel" })
        // Status will be set to "idle" when StreamEnded event arrives
        return
      }

      const now = Date.now()
      if (now - lastEscTime < ESC_DOUBLE_TAP_MS) {
        exit()
      } else {
        lastEscTime = now
      }
      return
    }

    // Ctrl+C: always quit immediately
    if (e.ctrl && e.name === "c") {
      exit()
      return
    }

    // Shift+Tab: cycle agent mode
    if (e.shift && e.name === "tab") {
      const newMode = client.mode() === "build" ? "plan" : "build"
      client.steer({ _tag: "SwitchMode", mode: newMode })
      return
    }

    // Ctrl+O: toggle tool output expansion
    if (e.ctrl && e.name === "o") {
      setToolsExpanded((prev) => !prev)
      return
    }

    // Ctrl+P: cycle through current-gen models (when not in command palette)
    if (e.ctrl && e.name === "p" && !command.paletteOpen()) {
      cycleModel()
      return
    }
  })

  const handleSubmit = (content: string, mode?: "queue" | "interject") => {
    if (mode === "interject" && client.isStreaming()) {
      client.steer({ _tag: "Interject", message: content })
      return
    }

    // First message in session starts in plan mode
    client.sendMessage(content, !hasMessages() ? "plan" : undefined)
  }

  // Handle input state transitions
  const handleInputEvent = (event: InputEvent) => {
    const result = transition(inputState(), event)
    setInputState(result.state)
    if (result.effect) {
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
        } else {
          const { decision, reason } = pickPlanDecision(effect.answers)
          cast(
            client.client.respondPlan(effect.requestId, decision, reason).pipe(
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
      compactHistory: Effect.gen(function* () {
        yield* Effect.sync(() => {
          startCompaction()
        })
        try {
          yield* client.compactBranch()
        } finally {
          yield* Effect.sync(() => {
            stopCompaction()
          })
        }
      }),
      createBranch: client.createBranch().pipe(Effect.asVoid),
      openTree: openBranchTree,
      openFork: openForkPicker,
      toggleBypass: Effect.gen(function* () {
        const current = client.session()?.bypass ?? true
        yield* client.updateSessionBypass(!current)
      }),
      openPermissions: () => router.navigateToPermissions(),
      openAuth: () => router.navigateToAuth(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.error) {
            client.setError(result.error)
          }
        }),
      ),
      Effect.asVoid,
    )

  const handleBranchSelect = (branchId: string) => {
    setTreeOpen(false)
    client.switchBranch(branchId)
    const session = client.session()
    if (session) {
      router.navigateToSession(session.sessionId, branchId)
    }
  }

  const handleForkSelect = (messageId: string) => {
    setForkOpen(false)
    cast(
      client.forkBranch(messageId).pipe(
        Effect.tap((branchId) =>
          Effect.sync(() => {
            client.switchBranch(branchId)
            const session = client.session()
            if (session) {
              router.navigateToSession(session.sessionId, branchId)
            }
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Messages */}
      <MessageList items={items()} toolsExpanded={toolsExpanded()} />

      {/* Thinking indicator */}
      <Indicators indicator={indicator()} />

      {/* Input with autocomplete above separator */}
      <Input
        onSubmit={handleSubmit}
        onSlashCommand={handleSlashCommand}
        clearMessages={clearMessages}
        inputState={inputState()}
        onInputEvent={handleInputEvent}
        onInputEffect={handleInputEffect}
      >
        <Input.Autocomplete />
        {/* Separator line */}
        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
        </box>
      </Input>

      <BranchTree
        open={treeOpen()}
        tree={treeNodes()}
        activeBranchId={client.session()?.branchId}
        onSelect={handleBranchSelect}
        onClose={() => setTreeOpen(false)}
      />

      <MessagePicker
        open={forkOpen()}
        messages={messages()}
        onSelect={handleForkSelect}
        onClose={() => setForkOpen(false)}
      />

      {/* Separator line */}
      <box flexShrink={0}>
        <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
      </box>

      {/* Status Bar */}
      <StatusBar.Root>
        <StatusBar.ErrorRow />
        <StatusBar.Row>
          <StatusBar.Mode />
          <StatusBar.Separator />
          <StatusBar.Model />
        </StatusBar.Row>
        <StatusBar.Row>
          <StatusBar.Cwd />
          <StatusBar.Separator />
          <StatusBar.Git />
          <StatusBar.Separator />
          <StatusBar.Cost />
        </StatusBar.Row>
      </StatusBar.Root>
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

const pickPlanDecision = (
  answers: readonly (readonly string[])[],
): { decision: "confirm" | "reject"; reason?: string } => {
  const selections = answers.flat().map((value) => value.trim())
  const normalized = selections.map((value) => value.toLowerCase())
  if (normalized.includes("confirm")) return { decision: "confirm" }
  if (normalized.includes("reject")) return { decision: "reject" }
  const reason = selections[0]
  return { decision: "reject", reason: reason && reason.length > 0 ? reason : undefined }
}
