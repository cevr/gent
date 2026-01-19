import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import figlet from "figlet"
import { useTheme } from "../theme/index.js"

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  createdAt: number
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  toolName: string
  status: "running" | "completed" | "error"
}

interface MessageListProps {
  messages: Message[]
}

const FONTS = ["Slant", "Calvin S", "ANSI Shadow", "Thin"] as const
const FONT = FONTS[Math.floor(Math.random() * FONTS.length)]!
const LOGO = figlet.textSync("gent", { font: FONT })


function UserMessage(props: { content: string }) {
  const { theme } = useTheme()
  return (
    <box
      marginTop={1}
      backgroundColor={theme.backgroundElement}
      paddingLeft={2}
      paddingRight={2}
    >
      <text style={{ fg: theme.text }}>{props.content}</text>
    </box>
  )
}

function AssistantMessage(props: { content: string; toolCalls: ToolCall[] | undefined }) {
  const { theme } = useTheme()
  return (
    <box marginTop={1} paddingLeft={2} flexDirection="column">
      <Show when={props.toolCalls && props.toolCalls.length > 0}>
        <box flexDirection="row" gap={2} marginBottom={props.content ? 1 : 0}>
          <For each={props.toolCalls}>
            {(tc) => <SingleToolCall toolCall={tc} />}
          </For>
        </box>
      </Show>
      <Show when={props.content}>
        <text style={{ fg: theme.text }}>{props.content}</text>
      </Show>
    </box>
  )
}

// Tool-specific spinner animations (fixed width: 3 chars)
const TOOL_SPINNERS: Record<string, readonly string[]> = {
  // File operations - scanning dots
  read: [".  ", ".. ", "..."],
  glob: [".  ", ".. ", "..."],
  grep: [".  ", ".. ", "..."],
  // Write/edit - typing cursor
  write: ["_  ", "   "],
  edit: ["_  ", "   "],
  // Bash - command prompt
  bash: [">  ", ">> ", ">>>"],
  // Network - signal waves
  webfetch: ["~  ", "~~ ", "~~~"],
  fetch: ["~  ", "~~ ", "~~~"],
  // Default - classic spinner
  default: [" | ", " / ", " - ", " \\ "],
}

function getSpinnerFrames(toolName: string): readonly string[] {
  const name = toolName.toLowerCase()
  return TOOL_SPINNERS[name] ?? TOOL_SPINNERS["default"]!
}

function useSpinner(toolName: string) {
  const [frame, setFrame] = createSignal(0)
  const frames = getSpinnerFrames(toolName)

  onMount(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length)
    }, 150)
    onCleanup(() => clearInterval(interval))
  })

  return () => frames[frame()]!
}

function SingleToolCall(props: { toolCall: ToolCall }) {
  const { theme } = useTheme()
  const spinner = useSpinner(props.toolCall.toolName)

  const color = () =>
    props.toolCall.status === "running"
      ? theme.warning
      : props.toolCall.status === "error"
        ? theme.error
        : theme.success

  const statusIcon = () =>
    props.toolCall.status === "running"
      ? spinner()
      : props.toolCall.status === "error"
        ? " x "
        : " + "

  return (
    <text style={{ fg: color() }}>
      [{statusIcon()}] {props.toolCall.toolName}
    </text>
  )
}

function Logo() {
  const { theme } = useTheme()
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <text style={{ fg: theme.textMuted }}>{LOGO}</text>
    </box>
  )
}

export function MessageList(props: MessageListProps) {
  return (
    <scrollbox
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={props.messages.length > 0} fallback={<Logo />}>
        <For each={props.messages}>
          {(msg) => (
            <Show
              when={msg.role === "user"}
              fallback={
                <AssistantMessage content={msg.content} toolCalls={msg.toolCalls} />
              }
            >
              <UserMessage content={msg.content} />
            </Show>
          )}
        </For>
      </Show>
    </scrollbox>
  )
}
