import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { InputRenderable } from "@opentui/core"
import { createSignal, createEffect, onMount, onCleanup } from "solid-js"
import { DEFAULT_MODEL_ID, calculateCost, type AgentMode, type ModelId } from "@gent/core"
import { extractText, buildToolResultMap, extractToolCallsWithResults, type GentClient, type MessageInfoReadonly } from "./client.js"
import { StatusBar } from "./components/status-bar.js"
import { MessageList, ThinkingIndicator, type Message } from "./components/message-list.js"
import { CommandPalette } from "./components/command-palette.js"
import { useGitInfo } from "./hooks/use-git-status.js"
import { ThemeProvider, useTheme } from "./theme/index.js"
import { CommandProvider, useCommand } from "./command/index.js"
import { ModelProvider, useModel } from "./model/index.js"

interface AppProps {
  client: GentClient
  sessionId: string
  branchId: string
  initialPrompt: string | undefined
  cwd?: string
  model?: string
  onModelChange?: (modelId: ModelId) => void
}

function AppContent(props: AppProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const command = useCommand()
  const model = useModel()
  const cwd = props.cwd ?? process.cwd()

  let inputRef: InputRenderable | null = null

  const [, setInputValue] = createSignal("")
  const [messages, setMessages] = createSignal<Message[]>([])
  const [agentMode] = createSignal<AgentMode>("build")
  const [cost, setCost] = createSignal(0)
  const [status, setStatus] = createSignal<"idle" | "streaming" | "error">("idle")
  const [error, setError] = createSignal<string | null>(null)
  const [elapsed, setElapsed] = createSignal(0)

  const gitInfo = useGitInfo(cwd)

  // Track elapsed time while streaming
  let elapsedInterval: ReturnType<typeof setInterval> | null = null

  createEffect(() => {
    if (status() === "streaming") {
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
  // Duration is stored on user message, but displayed after the last assistant message of that turn
  const buildMessages = (msgs: readonly MessageInfoReadonly[]): Message[] => {
    const resultMap = buildToolResultMap(msgs)
    const filteredMsgs = msgs.filter((m) => m.role !== "tool")

    // Build a map: for each user message index, store its turnDurationMs
    // Then assign to the previous assistant message
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
        // Check if next message is a user message with duration
        const nextIdx = i + 1
        const nextUserDuration = userMsgDurations.get(nextIdx)
        if (nextUserDuration !== undefined) {
          thinkTime = Math.round(nextUserDuration / 1000)
        } else if (nextIdx >= filteredMsgs.length) {
          // Last assistant message - check if there's a duration on the initiating user message
          // Find the user message that started this turn (last user message before this assistant)
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
      }
    })
  }

  // Load messages and subscribe to events
  onMount(() => {
    // Focus input
    inputRef?.focus()

    // Load existing messages
    void props.client.listMessages(props.branchId).then((msgs) => {
      setMessages(buildMessages(msgs))

      // Send initial prompt if provided
      if (props.initialPrompt !== undefined && props.initialPrompt !== "") {
        void props.client.sendMessage({
          sessionId: props.sessionId,
          branchId: props.branchId,
          content: props.initialPrompt,
        })
      }
    })
  })

  // Subscribe to agent events
  createEffect(() => {
    const unsubscribe = props.client.subscribeEvents(props.sessionId, (event) => {
      // Handle different event types
      if (event._tag === "MessageReceived") {
        // Refresh messages when a new message is received
        void props.client.listMessages(props.branchId).then((msgs) => {
          setMessages(buildMessages(msgs))
        })
      } else if (event._tag === "StreamStarted") {
        setStatus("streaming")
        setError(null)
        // Add placeholder assistant message
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            toolCalls: undefined,
            thinkTime: undefined,
          },
        ])
      } else if (event._tag === "StreamChunk") {
        // Update last message with chunk
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + event.chunk },
            ]
          }
          return prev
        })
      } else if (event._tag === "StreamEnded") {
        // Set thinkTime on last assistant message before changing status
        const thinkTime = elapsed()
        if (thinkTime > 0) {
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.role === "assistant") {
              return [
                ...prev.slice(0, -1),
                { ...last, thinkTime },
              ]
            }
            return prev
          })
        }
        setStatus("idle")
        // Calculate cost from usage
        if (event.usage) {
          const pricing = model.currentModelInfo()?.pricing
          const turnCost = calculateCost(event.usage, pricing)
          setCost((prev) => prev + turnCost)
        }
      } else if (event._tag === "ErrorOccurred") {
        setStatus("error")
        setError(event.error)
      } else if (event._tag === "ToolCallStarted") {
        // Add tool call to last assistant message
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
                    output: undefined,
                  },
                ],
              },
            ]
          }
          return prev
        })
      } else if (event._tag === "ToolCallCompleted") {
        // Update tool call status and output in last assistant message
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
                        output: event.output,
                      }
                    : tc
                ),
              },
            ]
          }
          return prev
        })
      }
      // TODO: handle cost from events when available
    })

    onCleanup(unsubscribe)
  })

  const exit = () => {
    renderer.destroy()
    process.exit(0)
  }

  // Delete word backward (Option+Backspace)
  const deleteWordBackward = () => {
    if (!inputRef) return
    const value = inputRef.value
    const cursor = inputRef.cursorPosition
    if (cursor === 0) return

    // Find start of current/previous word
    let pos = cursor - 1
    // Skip trailing spaces
    while (pos > 0 && value[pos - 1] === " ") pos--
    // Skip word characters
    while (pos > 0 && value[pos - 1] !== " ") pos--

    inputRef.value = value.slice(0, pos) + value.slice(cursor)
    inputRef.cursorPosition = pos
  }

  // Delete line backward (Cmd+Backspace)
  const deleteLineBackward = () => {
    if (!inputRef) return
    const value = inputRef.value
    const cursor = inputRef.cursorPosition
    if (cursor === 0) return

    inputRef.value = value.slice(cursor)
    inputRef.cursorPosition = 0
  }

  // Keyboard handlers
  useKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) {
      return
    }

    // ESC closes palette or quits
    if (e.name === "escape") {
      if (command.paletteOpen()) {
        command.closePalette()
      } else {
        exit()
      }
      return
    }

    // Ctrl+C: interrupt if streaming, otherwise quit
    if (e.ctrl && e.name === "c") {
      if (status() === "streaming") {
        void props.client.steer({ _tag: "Cancel" })
        setStatus("idle")
      } else {
        exit()
      }
      return
    }

    // Option+Backspace / Ctrl+W: delete word backward
    if ((e.meta && e.name === "backspace") || (e.ctrl && e.name === "w")) {
      deleteWordBackward()
      return
    }

    // Cmd+Backspace / Ctrl+U: delete line backward
    // Note: Cmd (super) often doesn't reach terminal apps, so Ctrl+U is the fallback
    if ((e.super && e.name === "backspace") || (e.ctrl && e.name === "u")) {
      deleteLineBackward()
      return
    }
  })

  const handleSubmit = (value: string) => {
    const text = value.trim()
    if (text) {
      setStatus("streaming")
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          createdAt: Date.now(),
          toolCalls: undefined,
          thinkTime: undefined,
        },
      ])

      void props.client.sendMessage({
        sessionId: props.sessionId,
        branchId: props.branchId,
        content: text,
      }).catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        setStatus("error")
        setError(error.message)
      })
      // Clear input
      if (inputRef) {
        inputRef.value = ""
      }
      setInputValue("")
    }
  }

  // Get the friendly display name for the current model, falling back to model ID
  const currentModelDisplay = () => {
    const info = model.currentModelInfo()
    return info?.name ?? model.currentModel()
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Messages */}
      <MessageList messages={messages()} />

      {/* Thinking indicator - fixed between messages and input */}
      <ThinkingIndicator elapsed={elapsed()} visible={status() === "streaming"} />

      {/* Separator line */}
      <box flexShrink={0}>
        <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
      </box>

      {/* Input */}
      <box flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text style={{ fg: theme.primary }}>❯ </text>
        <box flexGrow={1}>
          <input
            ref={(r) => (inputRef = r)}
            focused={!command.paletteOpen()}
            onInput={setInputValue}
            onSubmit={handleSubmit}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
          />
        </box>
      </box>

      {/* Separator line */}
      <box flexShrink={0}>
        <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
      </box>

      {/* Status Bar */}
      <StatusBar
        mode={agentMode()}
        model={currentModelDisplay()}
        cwd={cwd}
        gitRoot={gitInfo()?.root ?? null}
        git={gitInfo()?.status ?? null}
        cost={cost()}
        status={status()}
        error={error()}
      />

      {/* Command Palette */}
      <CommandPalette />
    </box>
  )
}

export function App(props: AppProps) {
  const initialModel = (props.model ?? DEFAULT_MODEL_ID) as ModelId

  return (
    <ThemeProvider mode={undefined}>
      <CommandProvider>
        <ModelProvider
          initialModel={initialModel}
          onModelChange={props.onModelChange}
        >
          <AppContent {...props} />
        </ModelProvider>
      </CommandProvider>
    </ThemeProvider>
  )
}
