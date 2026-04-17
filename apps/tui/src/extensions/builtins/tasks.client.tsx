import { TaskWidget, type TaskPreview } from "../../components/task-widget"
import { BackgroundTasksDialog } from "../../components/background-tasks-dialog"
import { createSignal, createMemo } from "solid-js"
import {
  borderLabelContribution,
  clientCommandContribution,
  overlayContribution,
  widgetContribution,
} from "@gent/core/domain/extension-client.js"
import type { TaskEntry } from "@gent/extensions/task-tools/identity.js"
import { TaskToolsPackage } from "@gent/extensions/task-tools-package.js"
import { useScopedKeyboard } from "../../keyboard/context"

export default TaskToolsPackage.tui((ctx) => {
  /** Read task list from extension snapshot (populated by per-pulse refetch
   *  of `TaskListRef` declared on `TaskToolsPackage.snapshotQuery`). */
  function useTasksFromSnapshot(): () => readonly TaskEntry[] {
    return createMemo(() => {
      const tasks = ctx.getSnapshot()
      return tasks ?? []
    })
  }

  // Shared task state sourced from extension snapshots
  const [overrideTasks, setOverrideTasks] = createSignal<readonly TaskEntry[] | undefined>(
    undefined,
  )

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

  return [
    widgetContribution({
      id: "tasks",
      slot: "below-messages",
      priority: 20,
      component: TrackedTaskWidget,
    }),
    widgetContribution({
      id: "task-tracker",
      slot: "below-input",
      priority: 999,
      component: () => {
        registerKeyboard()
        return <TaskTracker />
      },
    }),
    overlayContribution({
      id: "tasks-dialog",
      component: TasksDialogOverlay,
    }),
    clientCommandContribution({
      id: "tasks-dialog",
      title: "Background Tasks",
      description: "View and manage background tasks",
      category: "Tasks",
      keybind: "ctrl+shift+t",
      slash: "tasks",
      onSelect: () => ctx.openOverlay("tasks-dialog"),
    }),
    borderLabelContribution({
      position: "bottom-left",
      priority: 50,
      produce: () => {
        const count = runningCount()
        if (count === 0) return []
        return [{ text: `${count} task${count > 1 ? "s" : ""} ↓`, color: "info" }]
      },
    }),
  ]
})
