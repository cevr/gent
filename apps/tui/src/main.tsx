import { render, useKeyboard, useRenderer } from "@opentui/solid"
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

async function createSession(name: string): Promise<{ sessionId: string; branchId: string }> {
  const res = await fetch(`${API_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  return res.json()
}

async function sendMessage(sessionId: string, branchId: string, content: string): Promise<void> {
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

function App() {
  const renderer = useRenderer()
  const [inputValue, setInputValue] = createSignal("")
  const [messages, setMessages] = createSignal<Message[]>([])
  const [sessionId, setSessionId] = createSignal<string | null>(null)
  const [branchId, setBranchId] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal("Connecting...")

  // Initialize session
  onMount(async () => {
    try {
      const session = await createSession("TUI Session")
      setSessionId(session.sessionId)
      setBranchId(session.branchId)
      setStatus("Ready")
    } catch (e) {
      setStatus("Failed to connect - is server running?")
    }
  })

  // Poll for messages
  createEffect(() => {
    const bid = branchId()
    if (!bid) return

    const interval = setInterval(async () => {
      try {
        const msgs = await listMessages(bid)
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
    }
  })

  const handleSubmit = (value: string) => {
    const text = value.trim()
    if (text && sessionId() && branchId()) {
      sendMessage(sessionId()!, branchId()!, text)
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
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
        <Show
          when={messages().length > 0}
          fallback={
            <box marginTop={2} marginBottom={2}>
              <text style={{ fg: "gray" }}>No messages yet. Type below and press Enter!</text>
            </box>
          }
        >
          <For each={messages()}>{(msg) => <MessageBubble message={msg} />}</For>
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

// Start
render(() => <App />)
