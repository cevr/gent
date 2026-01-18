import { For, Show } from "solid-js"
import figlet from "figlet"
import { useTheme } from "../theme/index.js"

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  createdAt: number
}

interface MessageListProps {
  messages: Message[]
}

const FONTS = ["Slant", "Calvin S", "ANSI Shadow", "Thin"] as const
const FONT = FONTS[Math.floor(Math.random() * FONTS.length)]!
const LOGO = figlet.textSync("gent", { font: FONT })

// Minimal delineation:
// - User messages: subtle background
// - Assistant messages: no background, just content
function UserMessage(props: { content: string }) {
  const { theme } = useTheme()
  return (
    <box
      marginTop={1}
      backgroundColor={theme.backgroundElement}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text style={{ fg: theme.text }}>{props.content}</text>
    </box>
  )
}

function AssistantMessage(props: { content: string }) {
  const { theme } = useTheme()
  return (
    <box marginTop={1} paddingLeft={2}>
      <text style={{ fg: theme.text }}>{props.content}</text>
    </box>
  )
}

function Logo() {
  const { theme } = useTheme()
  return (
    <box
      flexGrow={1}
      justifyContent="center"
      alignItems="center"
    >
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
              fallback={<AssistantMessage content={msg.content} />}
            >
              <UserMessage content={msg.content} />
            </Show>
          )}
        </For>
      </Show>
    </scrollbox>
  )
}
