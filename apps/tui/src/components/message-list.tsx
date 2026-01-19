import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import figlet from "figlet"
import { createPatch } from "diff"
import { useTheme } from "../theme/index.js"

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  createdAt: number
  toolCalls: ToolCall[] | undefined
  thinkTime: number | undefined
}

export interface ToolCall {
  id: string
  toolName: string
  status: "running" | "completed" | "error"
  input: unknown | undefined
  output: string | undefined
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

function formatThinkTime(secs: number): string {
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = secs % 60
  return `${mins}m ${remainingSecs}s`
}

function AssistantMessage(props: {
  content: string
  toolCalls: ToolCall[] | undefined
  thinkTime: number | undefined
}) {
  const { theme } = useTheme()
  const hasContent = () => props.content || (props.toolCalls && props.toolCalls.length > 0)

  return (
    <box marginTop={hasContent() ? 1 : 0} paddingLeft={2} flexDirection="column">
      <Show when={props.toolCalls && props.toolCalls.length > 0}>
        <box flexDirection="column" marginBottom={props.content ? 1 : 0}>
          <For each={props.toolCalls}>
            {(tc) => <SingleToolCall toolCall={tc} />}
          </For>
        </box>
      </Show>
      <Show when={props.content}>
        <text style={{ fg: theme.text }}>{props.content}</text>
      </Show>
      <Show when={props.thinkTime !== undefined && props.thinkTime > 0}>
        <box marginTop={1}>
          <text style={{ fg: theme.textMuted }}>Thought for {formatThinkTime(props.thinkTime!)}</text>
        </box>
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

// Truncate path from start, keeping filename visible
// e.g., "/Users/cvr/Developer/personal/gent/apps/tui/src/app.tsx" -> "…/tui/src/app.tsx"
function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path
  const parts = path.split("/")
  let result = parts[parts.length - 1] ?? ""
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + "/" + result
    if (next.length + 1 > maxLen) break
    result = next
  }
  return "…/" + result
}

// Format tool input for display in parenthesis
function formatToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const obj = input as Record<string, unknown>

  switch (toolName.toLowerCase()) {
    case "bash":
      return typeof obj["command"] === "string" ? obj["command"] : ""
    case "read":
    case "write":
      return typeof obj["path"] === "string" ? truncatePath(obj["path"]) : ""
    case "edit":
      return typeof obj["path"] === "string" ? truncatePath(obj["path"]) : ""
    case "glob": {
      const pattern = typeof obj["pattern"] === "string" ? obj["pattern"] : ""
      const searchPath = typeof obj["path"] === "string" ? truncatePath(obj["path"], 30) : truncatePath(process.cwd(), 30)
      return pattern ? `${pattern} in ${searchPath}` : ""
    }
    case "grep": {
      const pattern = typeof obj["pattern"] === "string" ? obj["pattern"] : ""
      const searchPath = typeof obj["path"] === "string" ? truncatePath(obj["path"], 30) : truncatePath(process.cwd(), 30)
      return pattern ? `${pattern} in ${searchPath}` : ""
    }
    default:
      return ""
  }
}

// Detect filetype from path extension
function getFiletype(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", md: "markdown",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  }
  return ext ? map[ext] : undefined
}

// Count lines added/removed from old and new strings
function countDiffLines(oldStr: string, newStr: string): { added: number; removed: number } {
  const oldLines = oldStr ? oldStr.split("\n").length : 0
  const newLines = newStr ? newStr.split("\n").length : 0
  if (newLines > oldLines) {
    return { added: newLines - oldLines, removed: 0 }
  } else if (oldLines > newLines) {
    return { added: 0, removed: oldLines - newLines }
  }
  // Same line count - count actual changed lines
  const oldArr = oldStr.split("\n")
  const newArr = newStr.split("\n")
  let changed = 0
  for (let i = 0; i < oldArr.length; i++) {
    if (oldArr[i] !== newArr[i]) changed++
  }
  return { added: changed, removed: changed }
}

// Extract read tool info: line count from output
// Note: output is truncated JSON from runtime, so we extract line count from pattern
function getReadInfo(output: string | undefined): { lines: number } | null {
  if (!output) return null

  // Output is truncated JSON like: {"content":"   1\tline1\n   2\t..."}
  // Count line numbers by finding all occurrences of the pattern: digits followed by tab
  // The last line number tells us total lines read
  const lineNumMatches = output.match(/\d+\\t/g)
  if (!lineNumMatches || lineNumMatches.length === 0) return null

  // Get the highest line number found
  const lineNums = lineNumMatches.map(m => parseInt(m.replace("\\t", ""), 10))
  const maxLine = Math.max(...lineNums)

  return { lines: maxLine }
}

// Generate unified diff from edit input for <diff> component
function getEditUnifiedDiff(input: unknown): { diff: string; filetype: string | undefined; added: number; removed: number } | null {
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  const path = obj["path"]
  const oldStr = obj["oldString"] ?? obj["old_string"]
  const newStr = obj["newString"] ?? obj["new_string"]
  if (typeof path !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") return null

  const diff = createPatch(path, oldStr, newStr)
  const filetype = getFiletype(path)
  const { added, removed } = countDiffLines(oldStr, newStr)
  return { diff, filetype, added, removed }
}

function SingleToolCall(props: { toolCall: ToolCall }) {
  const { theme } = useTheme()
  const spinner = useSpinner(props.toolCall.toolName)
  const toolName = () => props.toolCall.toolName.toLowerCase()

  const statusColor = () =>
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

  const inputSummary = () => formatToolInput(props.toolCall.toolName, props.toolCall.input)
  const isEdit = () => toolName() === "edit"
  const isRead = () => toolName() === "read"
  const editData = () => isEdit() && props.toolCall.status !== "running" ? getEditUnifiedDiff(props.toolCall.input) : null
  const readInfo = () => isRead() && props.toolCall.status !== "running" ? getReadInfo(props.toolCall.output) : null

  // Only show generic output for bash (not edit/read/glob/grep/write)
  const noOutputTools = ["edit", "read", "glob", "grep", "write"]
  const showGenericOutput = () =>
    !noOutputTools.includes(toolName()) &&
    props.toolCall.output && props.toolCall.status !== "running"

  return (
    <box flexDirection="column">
      <text>
        <span style={{ fg: statusColor() }}>[{statusIcon()}]</span>
        <span style={{ fg: theme.info }}> {props.toolCall.toolName}</span>
        <Show when={inputSummary()}>
          <span style={{ fg: theme.textMuted }}>({inputSummary()})</span>
        </Show>
      </text>
      <Show when={editData()}>
        {(data) => (
          <box paddingLeft={4} flexDirection="column">
            <text>
              <span style={{ fg: theme.textMuted }}>└ Added </span>
              <span style={{ fg: theme.success, bold: true }}>{data().added}</span>
              <span style={{ fg: theme.textMuted }}> lines, removed </span>
              <span style={{ fg: theme.error, bold: true }}>{data().removed}</span>
              <span style={{ fg: theme.textMuted }}> lines</span>
            </text>
            <box marginTop={1}>
              <diff
                diff={data().diff}
                view="unified"
                filetype={data().filetype}
                showLineNumbers={true}
                addedBg="#1a4d1a"
                removedBg="#4d1a1a"
                addedSignColor="#22c55e"
                removedSignColor="#ef4444"
                lineNumberFg={theme.textMuted}
                width="100%"
              />
            </box>
          </box>
        )}
      </Show>
      <Show when={readInfo()}>
        {(info) => (
          <box paddingLeft={4}>
            <text>
              <span style={{ fg: theme.textMuted }}>└ Read </span>
              <span style={{ fg: theme.success, bold: true }}>{info().lines}</span>
              <span style={{ fg: theme.textMuted }}> lines</span>
            </text>
          </box>
        )}
      </Show>
      <Show when={showGenericOutput()}>
        <box paddingLeft={6}>
          <text style={{ fg: theme.textMuted }}>{props.toolCall.output}</text>
        </box>
      </Show>
    </box>
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

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"]
const DOTS_FRAMES = ["   ", ".  ", ".. ", "..."]

export interface ThinkingIndicatorProps {
  elapsed: number
  visible: boolean
}

export function ThinkingIndicator(props: ThinkingIndicatorProps) {
  const { theme } = useTheme()
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    const interval = setInterval(() => {
      if (props.visible) {
        setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
      }
    }, 150)
    onCleanup(() => clearInterval(interval))
  })

  const formatTime = () => {
    const secs = props.elapsed
    if (secs < 60) return `${secs}s`
    const mins = Math.floor(secs / 60)
    const remainingSecs = secs % 60
    return `${mins}m ${remainingSecs}s`
  }

  const spinner = () => SPINNER_FRAMES[frame()]
  const dots = () => DOTS_FRAMES[frame()]

  return (
    <Show when={props.visible}>
      <box flexShrink={0} paddingLeft={1}>
        <text>
          <span style={{ fg: theme.warning }}>{spinner()} </span>
          <span style={{ fg: theme.text }}>Thinking{dots()}</span>
          <span style={{ fg: theme.textMuted }}> {formatTime()} </span>
          <span style={{ fg: theme.textMuted }}>(</span>
          <span style={{ fg: theme.info, bold: true }}>ctrl+c</span>
          <span style={{ fg: theme.textMuted }}> to interrupt)</span>
        </text>
      </box>
    </Show>
  )
}

interface MessageListProps {
  messages: Message[]
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
                <AssistantMessage
                  content={msg.content}
                  toolCalls={msg.toolCalls}
                  thinkTime={msg.thinkTime}
                />
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
