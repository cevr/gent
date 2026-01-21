/**
 * Session route - message list, input, streaming
 */

import { createSignal, createEffect, onMount, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Effect, Runtime } from "effect"
import {
  extractText,
  buildToolResultMap,
  extractToolCallsWithResults,
  type MessageInfoReadonly,
} from "../client.js"
import { StatusBar } from "../components/status-bar"
import { MessageList, ThinkingIndicator, type Message } from "../components/message-list"
import { Input } from "../components/input"
import { useTheme } from "../theme/index"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
import { executeSlashCommand } from "../commands/slash-commands"
import { useRuntime } from "../hooks/use-runtime"
import { InputState, transition, type InputEvent, type InputEffect } from "../components/input-state"
import type { QuestionsAsked, PermissionRequested, PlanPresented } from "@gent/core"

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
  const { cast } = useRuntime(client.client.runtime)

  const [messages, setMessages] = createSignal<Message[]>([])
  const [elapsed, setElapsed] = createSignal(0)
  const [toolsExpanded, setToolsExpanded] = createSignal(false)
  const [inputState, setInputState] = createSignal<InputState>(InputState.normal())

  // Derived - no separate signal needed
  const hasMessages = () => messages().length > 0

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
  })

  // Build messages from raw messages
  const buildMessages = (msgs: readonly MessageInfoReadonly[]): Message[] => {
    const resultMap = buildToolResultMap(msgs)
    const filteredMsgs = msgs.filter((m) => m.role !== "tool")

    const userMsgDurations = new Map<number, number>()
    filteredMsgs.forEach((m, i) => {
      if (m.role === "user" && m.turnDurationMs !== undefined) {
        userMsgDurations.set(i, m.turnDurationMs)
      }
    })

    return filteredMsgs.map((m, i) => {
      const toolCalls = extractToolCallsWithResults(m.parts, resultMap)
      let thinkTime: number | undefined

      if (m.role === "assistant") {
        const nextIdx = i + 1
        const nextUserDuration = userMsgDurations.get(nextIdx)
        if (nextUserDuration !== undefined) {
          thinkTime = Math.round(nextUserDuration / 1000)
        } else if (nextIdx >= filteredMsgs.length) {
          for (let j = i - 1; j >= 0; j--) {
            const prev = filteredMsgs[j]
            if (prev?.role === "user" && prev.turnDurationMs !== undefined) {
              thinkTime = Math.round(prev.turnDurationMs / 1000)
              break
            }
          }
        }
      }

      return {
        id: m.id,
        role: m.role,
        content: extractText(m.parts),
        createdAt: m.createdAt,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        thinkTime,
        interrupted: undefined,
      }
    })
  }

  // Load messages when session becomes active
  createEffect(() => {
    if (!client.isActive()) return

    // Run listMessages and handle result
    Runtime.runPromise(client.client.runtime)(client.listMessages()).then((msgs) => {
      setMessages(buildMessages(msgs))
    }).catch((err) => {
      client.setError(err instanceof Error ? err.message : String(err))
    })
  })

  // Focus input on mount, send initial prompt if provided
  onMount(() => {
    if (props.initialPrompt) {
      cast(
        client.client.sendMessage({
          sessionId: props.sessionId,
          branchId: props.branchId,
          content: props.initialPrompt,
          mode: "plan",
        }).pipe(
          Effect.tapError((err) =>
            Effect.sync(() => {
              client.setError(String(err))
            }),
          ),
        ),
      )
    }
  })

  // Subscribe to agent events for message updates
  createEffect(() => {
    if (!client.isActive()) return

    const unsubscribe = client.subscribeEvents((event) => {
      if (event._tag === "MessageReceived") {
        Runtime.runPromise(client.client.runtime)(client.listMessages()).then((msgs) => {
          setMessages(buildMessages(msgs))
        }).catch((err) => {
          client.setError(err instanceof Error ? err.message : String(err))
        })
      } else if (event._tag === "StreamStarted") {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            toolCalls: undefined,
            thinkTime: undefined,
            interrupted: undefined,
          },
        ])
      } else if (event._tag === "StreamChunk") {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, content: last.content + event.chunk }]
          }
          return prev
        })
      } else if (event._tag === "StreamEnded") {
        const thinkTime = elapsed()
        const interrupted = event.interrupted === true
        if (thinkTime > 0 || interrupted) {
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.role === "assistant") {
              return [
                ...prev.slice(0, -1),
                { ...last, thinkTime: thinkTime > 0 ? thinkTime : undefined, interrupted },
              ]
            }
            return prev
          })
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

    onCleanup(unsubscribe)
  })

  const exit = () => {
    renderer.destroy()
    process.exit(0)
  }

  // Clear messages handler for /clear command
  const clearMessages = () => {
    setMessages([])
  }

  // Track pending ESC for double-tap quit
  let lastEscTime = 0
  const ESC_DOUBLE_TAP_MS = 500

  useKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) return

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
  })

  const handleSubmit = (content: string) => {
    // Status will be set to "streaming" when StreamStarted event arrives
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content,
        createdAt: Date.now(),
        toolCalls: undefined,
        thinkTime: undefined,
        interrupted: undefined,
      },
    ])

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
                  client.setError(String(err))
                }),
              ),
            ),
          )
        } else if (effect.kind === "permission") {
          const decision = pickPermissionDecision(effect.answers)
          cast(
            client.client.respondPermission(effect.requestId, decision).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(String(err))
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
                  client.setError(String(err))
                }),
              ),
            ),
          )
        }
        break
    }
  }

  const handleSlashCommand = async (cmd: string, args: string) => {
    const result = await executeSlashCommand(cmd, args, {
      openPalette: () => command.openPalette(),
      clearMessages,
      navigateToSessions: () => command.openPalette(),
      compactHistory: async () => {
        client.setError("Compact not implemented yet")
      },
      createBranch: async () => {
        cast(client.createBranch())
      },
    })

    if (result.error) {
      client.setError(result.error)
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Messages */}
      <MessageList messages={messages()} toolsExpanded={toolsExpanded()} />

      {/* Thinking indicator */}
      <ThinkingIndicator elapsed={elapsed()} visible={client.isStreaming()} />

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
          <StatusBar.Separator />
          <StatusBar.Status />
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
): "allow" | "deny" => {
  const selections = answers.flat().map((value) => value.trim().toLowerCase())
  if (selections.includes("allow")) return "allow"
  if (selections.includes("deny")) return "deny"
  return "deny"
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
