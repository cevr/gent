import type { ExtensionClientModule } from "@gent/core/domain/extension-client.js"
import { TaskWidget, type TaskPreview } from "../../components/task-widget"
import { BackgroundTasksDialog } from "../../components/background-tasks-dialog"
import { createSignal, createMemo } from "solid-js"
import type { Task } from "@gent/core/domain/task.js"
import { useScopedKeyboard } from "../../keyboard/context"
import { useExtensionUI } from "../context"

const EXTENSION_ID = "@gent/task-tools"

export default {
  id: "@gent/tasks",
  setup: (ctx) => {
    /** Read task list from extension snapshot (populated by server-side task-tools actor). */
    function useTasksFromSnapshot(): () => Task[] {
      const ext = useExtensionUI()
      return createMemo(() => {
        const snapshot = ext.snapshots().get(EXTENSION_ID)
        if (snapshot === undefined) return []
        const model = snapshot.model as { tasks?: unknown[] } | undefined
        if (model?.tasks === undefined) return []
        return model.tasks as Task[]
      })
    }

    // Shared task state sourced from extension snapshots
    const [overrideTasks, setOverrideTasks] = createSignal<Task[] | undefined>(undefined)

    /** Invisible widget that reads tasks from extension snapshot and maintains shared state. */
    function TaskTracker() {
      const tasks = useTasksFromSnapshot()
      // Propagate to shared signal for border labels (which run outside render tree)
      createMemo(() => setOverrideTasks(tasks()))
      return null
    }

    const trackedTasks = () => overrideTasks() ?? []

    const runningCount = () => {
      const t = trackedTasks()
      return t.filter((x) => x.status === "in_progress" || x.status === "pending").length
    }

    /** Overlay wrapper that passes tracked tasks to the dialog. */
    function TasksDialogOverlay(overlayProps: { open: boolean; onClose: () => void }) {
      return (
        <BackgroundTasksDialog
          open={overlayProps.open}
          onClose={overlayProps.onClose}
          tasks={trackedTasks()}
        />
      )
    }

    /** TaskWidget fed from shared tracked state — single source of truth. */
    function TrackedTaskWidget() {
      const previews = createMemo((): TaskPreview[] =>
        trackedTasks().map((t) => ({ subject: t.subject, status: t.status })),
      )
      return <TaskWidget previewTasks={previews()} />
    }

    // Down-arrow opens tasks dialog when draft is empty and tasks are running
    const registerKeyboard = () => {
      useScopedKeyboard(
        (event) => {
          if (event.name !== "down") return false
          const cs = ctx.composerState()
          if (cs.draft !== "" || !cs.inputFocused) return false
          if (runningCount() === 0) return false
          ctx.openOverlay("tasks-dialog")
          return true
        },
        { when: () => runningCount() > 0 },
      )
    }

    return {
      widgets: [
        {
          id: "tasks",
          slot: "below-messages" as const,
          priority: 20,
          component: TrackedTaskWidget,
        },
        {
          id: "task-tracker",
          slot: "below-input" as const,
          priority: 999,
          component: () => {
            registerKeyboard()
            return <TaskTracker />
          },
        },
      ],
      overlays: [
        {
          id: "tasks-dialog",
          component: TasksDialogOverlay,
        },
      ],
      commands: [
        {
          id: "tasks-dialog",
          title: "Background Tasks",
          description: "View and manage background tasks",
          category: "Tasks",
          keybind: "ctrl+shift+t",
          slash: "tasks",
          onSelect: () => ctx.openOverlay("tasks-dialog"),
        },
      ],
      borderLabels: [
        {
          position: "bottom-left" as const,
          priority: 50,
          produce: () => {
            const count = runningCount()
            if (count === 0) return []
            return [{ text: `${count} task${count > 1 ? "s" : ""} ↓`, color: "info" }]
          },
        },
      ],
    }
  },
} satisfies ExtensionClientModule
