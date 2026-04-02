import type { ExtensionClientModule } from "@gent/core/domain/extension-client.js"
import { TaskWidget } from "../../components/task-widget"
import { BackgroundTasksDialog } from "../../components/background-tasks-dialog"
import { createSignal, createEffect, onCleanup } from "solid-js"
import { Effect, Fiber, Stream } from "effect"
import type { Task } from "@gent/core/domain/task.js"
import { useScopedKeyboard } from "../../keyboard/context"
import { useClient } from "../../client/context"
import { useRuntime } from "../../hooks/use-runtime"
import { runWithReconnect } from "../../utils/run-with-reconnect"

export default {
  id: "@gent/tasks",
  setup: (ctx) => {
    // Shared task state — populated by TaskTracker widget, read by border label
    const [trackedTasks, setTrackedTasks] = createSignal<Task[]>([])

    const runningCount = () => {
      const t = trackedTasks()
      return t.filter((x) => x.status === "in_progress" || x.status === "pending").length
    }

    /** Invisible widget that subscribes to task events and maintains the task list. */
    function TaskTracker() {
      const clientCtx = useClient()
      const { cast } = useRuntime(clientCtx.runtime, clientCtx.log)

      const refreshTasks = () => {
        const sid = clientCtx.session()?.sessionId
        const bid = clientCtx.session()?.branchId
        if (sid === undefined || bid === undefined) return
        cast(
          clientCtx.client.task.list({ sessionId: sid, branchId: bid }).pipe(
            Effect.tap((result) => Effect.sync(() => setTrackedTasks([...result]))),
            Effect.catchEager(() => Effect.void),
          ),
        )
      }

      // Initial load
      createEffect(() => {
        if (!clientCtx.isActive()) return
        refreshTasks()
      })

      // Subscribe to task events
      createEffect(() => {
        if (!clientCtx.isActive()) return
        const sid = clientCtx.session()?.sessionId
        const bid = clientCtx.session()?.branchId
        if (sid === undefined || bid === undefined) return

        const fiber = clientCtx.runtime.fork(
          runWithReconnect(
            () =>
              clientCtx.client.session.events({ sessionId: sid, branchId: bid }).pipe(
                Stream.runForEach((envelope) =>
                  Effect.sync(() => {
                    const tag = envelope.event._tag
                    if (
                      tag === "TaskCreated" ||
                      tag === "TaskUpdated" ||
                      tag === "TaskCompleted" ||
                      tag === "TaskFailed" ||
                      tag === "TaskStopped" ||
                      tag === "TaskDeleted"
                    ) {
                      refreshTasks()
                    }
                  }),
                ),
              ),
            {
              label: "tasks.events",
              log: clientCtx.log,
              onError: () => undefined,
              waitForRetry: () => clientCtx.waitForTransportReady(),
            },
          ),
        )

        onCleanup(() => {
          Effect.runFork(Fiber.interrupt(fiber))
        })
      })

      // Down-arrow opens tasks dialog when draft is empty and tasks are running
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

      // Invisible — just subscribes and updates shared state
      return null
    }

    /** Overlay wrapper that passes tracked tasks to the dialog. */
    function TasksDialogOverlay(overlayProps: { open: boolean; onClose: () => void }) {
      const clientCtx = useClient()
      const { cast } = useRuntime(clientCtx.runtime, clientCtx.log)

      const refreshTasks = () => {
        const sid = clientCtx.session()?.sessionId
        const bid = clientCtx.session()?.branchId
        if (sid === undefined || bid === undefined) return
        cast(
          clientCtx.client.task.list({ sessionId: sid, branchId: bid }).pipe(
            Effect.tap((result) => Effect.sync(() => setTrackedTasks([...result]))),
            Effect.catchEager(() => Effect.void),
          ),
        )
      }

      return (
        <BackgroundTasksDialog
          open={overlayProps.open}
          onClose={overlayProps.onClose}
          tasks={trackedTasks()}
          onRefresh={refreshTasks}
        />
      )
    }

    /** TaskWidget fed from shared tracked state — single source of truth. */
    function TrackedTaskWidget() {
      return <TaskWidget previewTasks={trackedTasks()} />
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
          component: TaskTracker,
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
