import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { InputRenderable } from "@opentui/core"
import { createSignal, createEffect, onMount, onCleanup } from "solid-js"
import type { AgentMode, ModelId } from "@gent/core"
import { extractText, type GentClient } from "./client.js"
import { StatusBar } from "./components/status-bar.js"
import { MessageList, type Message } from "./components/message-list.js"
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
  const [agentMode] = createSignal<AgentMode>("auto")
  const [cost] = createSignal(0)
  const [status, setStatus] = createSignal<"idle" | "streaming" | "error">("idle")
  const [error, setError] = createSignal<string | null>(null)

  const gitInfo = useGitInfo(cwd)

  // Load messages and subscribe to events
  onMount(() => {
    // Focus input
    inputRef?.focus()

    // Load existing messages
    void props.client.listMessages(props.branchId).then((msgs) => {
      setMessages(
        msgs.map((m) => ({
          id: m.id,
          role: m.role,
          content: extractText(m.parts),
          createdAt: m.createdAt,
        }))
      )

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
          setMessages(
            msgs.map((m) => ({
              id: m.id,
              role: m.role,
              content: extractText(m.parts),
              createdAt: m.createdAt,
            }))
          )
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
        setStatus("idle")
      } else if (event._tag === "ErrorOccurred") {
        setStatus("error")
        setError(event.error)
      }
      // TODO: handle cost from events when available
    })

    onCleanup(unsubscribe)
  })

  const exit = () => {
    renderer.destroy()
    process.exit(0)
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

    // Ctrl+C to quit
    if (e.ctrl && e.name === "c") {
      exit()
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

  // Current model display name
  const currentModelDisplay = () => {
    const info = model.currentModelInfo()
    return info?.name ?? model.currentModel()
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Messages */}
      <MessageList messages={messages()} />

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
  const initialModel = (props.model ?? "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0") as ModelId

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
