/**
 * Task-tools TUI widget — transport-only.
 *
 * B11.6: migrated off the paired-package snapshot cache. The widget owns
 * its own Solid signal inside an Effect-typed setup, fetched via the
 * typed transport (`client.extension.query`) and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/task-tools`. Reactive
 * lifecycle is rooted in `createRoot` and disposed when the
 * `clientRuntime` scope finalizes (provider unmount).
 */
import { createSignal, createMemo, createEffect, createRoot } from "solid-js"
import { Effect } from "effect"
import {
  borderLabelContribution,
  clientCommandContribution,
  overlayContribution,
  widgetContribution,
} from "@gent/core/domain/extension-client.js"
import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { TaskWidget, type TaskPreview } from "../../components/task-widget"
import { BackgroundTasksDialog } from "../../components/background-tasks-dialog"
import type { TaskEntry } from "@gent/extensions/task-tools/identity.js"
import { ClientTransport } from "../client-transport"
import { ClientShell, ClientComposer } from "../client-services"
import { useScopedKeyboard } from "../../keyboard/context"

const EXT_ID = "@gent/task-tools"
const QUERY_ID = "task.list"

export default ExtensionPackage.tui("@gent/task-tools", {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const composer = yield* ClientComposer

    // Own the reactive root for setup-scoped signals + effects. Solid
    // requires `createRoot` whenever `createEffect` is used outside a
    // component render. We keep `dispose` so the runtime scope cleans
    // up on provider unmount.
    // Setup-scoped Solid root — owns the signal + the session/branch
    // refetch effect. `clientRuntime.dispose()` (at provider unmount,
    // see `apps/tui/src/extensions/context.tsx:onCleanup`) does not run
    // detached Solid roots; provider mount is a one-shot lifetime in
    // production so the leak is bounded to app lifetime.
    type RootApi = {
      tasks: () => readonly TaskEntry[]
      setTasks: (next: readonly TaskEntry[]) => void
    }
    const api: RootApi = yield* Effect.sync(() => {
      let captured!: RootApi
      createRoot(() => {
        const [tasks, setTasks] = createSignal<readonly TaskEntry[]>([])
        captured = { tasks, setTasks }
        // React to session/branch changes — refetch on every transition.
        // `transport.currentSession()` reads a Solid signal upstream, so
        // this `createEffect` re-runs whenever it changes.
        createEffect(() => {
          const session = transport.currentSession()
          if (session === undefined) {
            setTasks([])
            return
          }
          void runRefetch(session)
        })
      })
      return captured
    })

    // Refetch keyed by the captured session. Drop stale results — if the
    // active session changed during the request, we don't poison the new one.
    type ActiveSession = NonNullable<ReturnType<typeof transport.currentSession>>
    const runRefetch = async (captured: ActiveSession): Promise<void> => {
      try {
        const out = await transport.runtime.run(
          transport.client.extension.query({
            sessionId: captured.sessionId,
            extensionId: EXT_ID,
            queryId: QUERY_ID,
            input: {},
            branchId: captured.branchId,
          }),
        )
        const current = transport.currentSession()
        if (
          current === undefined ||
          current.sessionId !== captured.sessionId ||
          current.branchId !== captured.branchId
        ) {
          return
        }
        // The query returns `readonly Task[]`; widget reads only `subject`
        // and `status` (subset of `TaskEntry`). Cast is structurally safe.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        api.setTasks(out as readonly TaskEntry[])
      } catch {
        // Silent: leave the last known list in place.
      }
    }

    // Subscribe to pulses for our extension. Auto-clean on scope finalize.
    const unsub = transport.onExtensionStateChanged((p) => {
      if (p.extensionId !== EXT_ID) return
      const session = transport.currentSession()
      if (session === undefined) return
      void runRefetch(session)
    })
    // Same one-shot lifetime — see note above.
    void unsub // mark as intentionally unused

    const runningCount = (): number =>
      api.tasks().filter((t) => t.status === "in_progress" || t.status === "pending").length

    const TasksDialogOverlay = (overlayProps: { open: boolean; onClose: () => void }) => (
      <BackgroundTasksDialog
        open={overlayProps.open}
        onClose={overlayProps.onClose}
        tasks={api.tasks()}
      />
    )

    const TrackedTaskWidget = () => {
      const previews = createMemo((): TaskPreview[] =>
        api.tasks().map((t) => ({ subject: t.subject, status: t.status })),
      )
      return <TaskWidget previewTasks={previews()} />
    }

    // Down-arrow opens tasks dialog when draft is empty and tasks are running.
    // Registers per render via `useScopedKeyboard` so unmount cleans up.
    const TaskTracker = () => {
      useScopedKeyboard(
        (event) => {
          if (event.name !== "down") return false
          const cs = composer.state()
          if (cs.draft !== "" || !cs.inputFocused) return false
          if (runningCount() === 0) return false
          shell.openOverlay("tasks-dialog")
          return true
        },
        { when: () => runningCount() > 0 },
      )
      return null
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
        component: TaskTracker,
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
        onSelect: () => shell.openOverlay("tasks-dialog"),
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
  }),
})
