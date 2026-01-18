import { For, Show } from "solid-js"

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  createdAt: number
}

interface MessageListProps {
  messages: Message[]
}

const LOGO = `
                    __
   ____ ____  ___  / /_
  / __ \`/ _ \\/ _ \\/ __/
 / /_/ /  __/  __/ /_
 \\__, /\\___/\\___/\\__/
/____/
`

// Minimal delineation:
// - User messages: subtle background
// - Assistant messages: no background, just content
function UserMessage(props: { content: string }) {
  return (
    <box
      marginTop={1}
      backgroundColor="#1a1a2e"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text style={{ fg: "white" }}>{props.content}</text>
    </box>
  )
}

function AssistantMessage(props: { content: string }) {
  return (
    <box marginTop={1} paddingLeft={2}>
      <text style={{ fg: "white" }}>{props.content}</text>
    </box>
  )
}

function Logo() {
  return (
    <box
      flexGrow={1}
      justifyContent="center"
      alignItems="center"
    >
      <text style={{ fg: "gray" }}>{LOGO}</text>
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
