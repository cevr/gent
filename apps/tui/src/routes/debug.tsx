import { createMemo, createSignal, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useExit } from "../hooks/use-exit"
import { MessageList } from "../components/message-list"
import { Input } from "../components/input"
import { TaskWidget } from "../components/task-widget"
import {
  BorderedInput,
  formatCwdGit,
  formatElapsed,
  type BorderLabelItem,
} from "../components/bordered-input"
import { useTheme, buildSyntaxStyle } from "../theme/index"
import { useWorkspace } from "../workspace/index"
import { useSpinnerClock } from "../hooks/use-spinner-clock"
import { buildTopRightLabels } from "../utils/session-labels"
import { Effect } from "effect"
import { DEBUG_CHILD_SESSIONS, DEBUG_ITEMS, DEBUG_TASKS } from "./debug-fixtures"
import type { SessionItem } from "../components/message-list"

export function DebugPlayground() {
  const { theme } = useTheme()
  const workspace = useWorkspace()
  const { exit, handleEsc } = useExit()
  const tick = useSpinnerClock()
  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))
  const [toolsExpanded, setToolsExpanded] = createSignal(true)
  const [showTasks, setShowTasks] = createSignal(true)
  const [items, setItems] = createSignal<SessionItem[]>([...DEBUG_ITEMS])

  const handleSubmit = (content: string, mode?: "queue" | "interject") => {
    setItems((current) => [
      ...current,
      {
        _tag: "message",
        id: crypto.randomUUID(),
        role: "user",
        kind: mode === "interject" ? "interjection" : "regular",
        content,
        reasoning: "",
        images: [],
        createdAt: Date.now(),
        toolCalls: undefined,
      },
    ])
  }

  const spinner = () => {
    const frames = ["·", "•", "*"]
    return frames[tick() % frames.length] ?? "·"
  }

  useKeyboard((e) => {
    if (e.ctrl === true && e.name === "o") {
      setToolsExpanded((prev) => !prev)
      return
    }

    if (e.ctrl === true && e.name === "t") {
      setShowTasks((prev) => !prev)
      return
    }

    if (e.ctrl === true && e.name === "c") {
      exit()
      return
    }

    if (e.name === "escape") {
      handleEsc()
    }
  })

  const topRight = () =>
    buildTopRightLabels("debug", "preview", 18342, 200000, theme) satisfies BorderLabelItem[]

  const bottomLeft = (): BorderLabelItem[] => [
    { text: spinner(), color: theme.textMuted },
    { text: "debug playground", color: theme.info },
    { text: toolsExpanded() ? "expanded" : "collapsed", color: theme.textMuted },
    { text: `tasks ${showTasks() ? "on" : "off"}`, color: theme.textMuted },
    { text: formatElapsed(4200), color: theme.textMuted },
  ]

  const bottomRight = (): BorderLabelItem[] => [
    {
      text: formatCwdGit(workspace.cwd, workspace.gitRoot(), workspace.gitStatus()?.branch),
      color: theme.textMuted,
    },
  ]

  return (
    <box flexDirection="column" flexGrow={1}>
      <box paddingLeft={2} paddingTop={1} paddingBottom={1} flexDirection="column" flexShrink={0}>
        <text>
          <span style={{ fg: theme.info, bold: true }}>Debug Playground</span>
          <span style={{ fg: theme.textMuted }}>
            {" "}
            ctrl+o toggle tools • ctrl+t toggle tasks • esc esc quit
          </span>
        </text>
      </box>

      <MessageList
        items={items()}
        toolsExpanded={toolsExpanded()}
        syntaxStyle={syntaxStyle}
        streaming={false}
        getChildSessions={(toolCallId) => [...(DEBUG_CHILD_SESSIONS[toolCallId] ?? [])]}
        footer={
          <Show when={showTasks()}>
            <TaskWidget previewTasks={DEBUG_TASKS} />
          </Show>
        }
      />

      <BorderedInput
        topLeft={[{ text: "$0.14", color: theme.textMuted }]}
        topRight={topRight()}
        bottomLeft={bottomLeft()}
        bottomRight={bottomRight()}
      >
        <Input onSubmit={handleSubmit} onSlashCommand={() => Effect.void}>
          <Input.Autocomplete />
        </Input>
      </BorderedInput>
    </box>
  )
}
