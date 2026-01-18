import { useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, createEffect, For, Show, onMount } from "solid-js"

// Types
interface Message {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt: number
}

// API client
const API_URL = "http://localhost:3000"

async function sendMessage(
  sessionId: string,
  branchId: string,
  content: string
): Promise<void> {
  await fetch(`${API_URL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, branchId, content }),
  })
}

async function listMessages(branchId: string): Promise<Message[]> {
  const res = await fetch(`${API_URL}/messages/${branchId}`)
  const data = await res.json()
  return data.map((m: any) => ({
    id: m.id,
    role: m.role,
    content: m.parts.find((p: any) => p._tag === "TextPart")?.text ?? "",
    createdAt: m.createdAt,
  }))
}

// Components
function MessageBubble(props: { message: Message }) {
  const isUser = () => props.message.role === "user"
  return (
    <box marginTop={1} marginBottom={1}>
      <text style={{ fg: isUser() ? "cyan" : "green" }}>
        <b>{isUser() ? "You" : "Assistant"}: </b>
        <span>{props.message.content}</span>
      </text>
    </box>
  )
}

interface AppProps {
  sessionId: string
  branchId: string
  initialPrompt: string | undefined
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  const [inputValue, setInputValue] = createSignal("")
  const [messages, setMessages] = createSignal<Message[]>([])
  const [status, setStatus] = createSignal("Ready")

  // Send initial prompt if provided
  onMount(async () => {
    if (props.initialPrompt) {
      setStatus("Sending...")
      await sendMessage(props.sessionId, props.branchId, props.initialPrompt)
      setStatus("Ready")
    }
  })

  // Poll for messages
  createEffect(() => {
    const interval = setInterval(async () => {
      try {
        const msgs = await listMessages(props.branchId)
        setMessages(msgs)
      } catch {
        // ignore
      }
    }, 1000)

    return () => clearInterval(interval)
  })

  // ESC to quit
  useKeyboard((e) => {
    if (e.name === "escape") {
      renderer.destroy()
      process.exit(0)
    }
  })

  const handleSubmit = (value: string) => {
    const text = value.trim()
    if (text) {
      setStatus("Sending...")
      sendMessage(props.sessionId, props.branchId, text).then(() => {
        setStatus("Ready")
      })
      setInputValue("")
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <box flexShrink={0} border paddingLeft={1} paddingRight={1}>
        <text>
          <b style={{ fg: "magenta" }}>gent</b>
          <span style={{ fg: "gray" }}> | {status()}</span>
          <span style={{ fg: "gray" }}> | ESC to quit</span>
        </text>
      </box>

      {/* Messages */}
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        paddingLeft={1}
        paddingRight={1}
      >
        <Show
          when={messages().length > 0}
          fallback={
            <box marginTop={2} marginBottom={2}>
              <text style={{ fg: "gray" }}>
                No messages yet. Type below and press Enter!
              </text>
            </box>
          }
        >
          <For each={messages()}>
            {(msg) => <MessageBubble message={msg} />}
          </For>
        </Show>
      </scrollbox>

      {/* Input */}
      <box flexShrink={0} height={3} border>
        <input
          focused
          placeholder="Type a message..."
          value={inputValue()}
          onInput={setInputValue}
          onSubmit={handleSubmit}
          width="100%"
        />
      </box>
    </box>
  )
}
