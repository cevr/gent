/**
 * Session route - message list, input, streaming
 */

import { createSignal, createEffect, onMount, onCleanup } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { calculateCost } from "@gent/core"
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
import { useModel } from "../model/index"
import { useClient } from "../client/index"
import { useAgentState } from "../agent-state/index"
import { executeSlashCommand } from "../commands/slash-commands"

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
  const model = useModel()
  const client = useClient()
  const agentState = useAgentState()

  const [messages, setMessages] = createSignal<Message[]>([])
  const [elapsed, setElapsed] = createSignal(0)
  const [toolsExpanded, setToolsExpanded] = createSignal(false)
  const [firstMessageSent, setFirstMessageSent] = createSignal(false)

  // Track elapsed time while streaming
  let elapsedInterval: ReturnType<typeof setInterval> | null = null

  createEffect(() => {
    if (agentState.status() === "streaming") {
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

    void client
      .listMessages()
      .then((msgs) => {
        setMessages(buildMessages(msgs))
        if (msgs.length > 0) {
          setFirstMessageSent(true)
        }
      })
      .catch((e: unknown) => {
        agentState.setError(e instanceof Error ? e.message : String(e))
      })
  })

  // Focus input on mount, send initial prompt if provided
  onMount(() => {
    if (props.initialPrompt) {
      setFirstMessageSent(true)
      void client.sendMessage(props.initialPrompt, "plan").catch((e: unknown) => {
        agentState.setStatus("error")
        agentState.setError(e instanceof Error ? e.message : String(e))
      })
    }
  })

  // Subscribe to agent events
  createEffect(() => {
    if (!client.isActive()) return

    const unsubscribe = client.subscribeEvents((event) => {
      if (event._tag === "MessageReceived") {
        void client
          .listMessages()
          .then((msgs) => {
            setMessages(buildMessages(msgs))
          })
          .catch((e: unknown) => {
            agentState.setError(e instanceof Error ? e.message : String(e))
          })
      } else if (event._tag === "StreamStarted") {
        agentState.setStatus("streaming")
        agentState.setError(null)
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
        agentState.setStatus("idle")
        if (event.usage) {
          const pricing = model.currentModelInfo()?.pricing
          const turnCost = calculateCost(event.usage, pricing)
          agentState.addCost(turnCost)
        }
      } else if (event._tag === "ErrorOccurred") {
        agentState.setStatus("error")
        agentState.setError(event.error)
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
      } else if (event._tag === "PlanModeEntered") {
        agentState.setMode("plan")
      } else if (event._tag === "PlanModeExited") {
        agentState.setMode("build")
      }
    })

    onCleanup(unsubscribe)
  })

  const exit = () => {
    renderer.destroy()
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

      if (agentState.status() === "streaming") {
        void client.steer({ _tag: "Cancel" }).catch(() => {})
        agentState.setStatus("idle")
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
      const newMode = agentState.mode() === "build" ? "plan" : "build"
      agentState.setMode(newMode)
      void client.steer({ _tag: "SwitchMode", mode: newMode }).catch(() => {})
      return
    }

    // Ctrl+O: toggle tool output expansion
    if (e.ctrl && e.name === "o") {
      setToolsExpanded((prev) => !prev)
      return
    }
  })

  const handleSubmit = (content: string) => {
    agentState.setStatus("streaming")
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

    const isFirst = !firstMessageSent()
    if (isFirst) setFirstMessageSent(true)

    void client.sendMessage(content, isFirst ? "plan" : undefined).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      agentState.setStatus("error")
      agentState.setError(error.message)
    })
  }

  const handleSlashCommand = async (cmd: string, args: string) => {
    const result = await executeSlashCommand(cmd, args, {
      openPalette: () => command.openPalette(),
      clearMessages,
      navigateToSessions: () => command.openPalette(),
      compactHistory: async () => {
        agentState.setError("Compact not implemented yet")
      },
      createBranch: async () => {
        await client.createBranch()
      },
    })

    if (result.error) {
      agentState.setError(result.error)
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Messages */}
      <MessageList messages={messages()} toolsExpanded={toolsExpanded()} />

      {/* Thinking indicator */}
      <ThinkingIndicator elapsed={elapsed()} visible={agentState.status() === "streaming"} />

      {/* Input with autocomplete above separator */}
      <Input
        onSubmit={handleSubmit}
        onSlashCommand={handleSlashCommand}
        clearMessages={clearMessages}
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
