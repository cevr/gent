/**
 * Task-tools TUI widget — transport-only.
 *
 * B11.6: migrated off the paired-package snapshot cache. The widget owns
 * its own Solid signal inside an Effect-typed setup, fetched via the
 * typed transport (`client.extension.query`) and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/task-tools`.
 *
 * Lifecycle: setup runs once per `ExtensionUIProvider` mount via
 * `runtime.runPromise`, which has no lasting scope. The Solid `createRoot`
 * + pulse subscription leak for the lifetime of the provider mount; in
 * production that is the lifetime of the app (one-shot mount). A future
 * remount-capable provider would need a per-extension scope; for now this
 * is a bounded, app-lifetime leak.
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

    type ActiveSession = NonNullable<ReturnType<typeof transport.currentSession>>

    // State owns its (sid, bid) key. The `produce`/component readers gate
    // on key match against the live session, so a stale leftover from the
    // prior session never renders or drives commands. The signal is set
    // up inside the detached `createRoot` below so its reactive scope
    // matches the lifecycle of the refetch effect.
    type Keyed = {
      readonly sessionId: string
      readonly branchId: string
      readonly tasks: readonly TaskEntry[]
    }
    let getState!: () => Keyed | undefined
    let setState!: (next: Keyed | undefined) => void

    const liveTasks = (): readonly TaskEntry[] => {
      const s = getState()
      const cur = transport.currentSession()
      if (s === undefined || cur === undefined) return []
      if (s.sessionId !== cur.sessionId || s.branchId !== cur.branchId) return []
      return s.tasks
    }

    // Refetch keyed by the captured session. Two-stage stale check:
    // (a) drop the response if the active session changed during the
    //     request — otherwise late responses overwrite the new session;
    // (b) `liveTasks()` re-checks at render — covers the gap between
    //     state set and the next session change.
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
        setState({
          sessionId: captured.sessionId,
          branchId: captured.branchId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          tasks: out as readonly TaskEntry[],
        })
      } catch (err) {
        // Visible refresh failures matter — surface to console (the only
        // log surface available pre-render). Last good state stays.
        console.warn(
          `[${EXT_ID}] task list refresh failed:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // Detached Solid root — see header lifecycle note. We never call
    // dispose; provider mount is one-shot.
    yield* Effect.sync(() => {
      createRoot(() => {
        const [s, set] = createSignal<Keyed | undefined>(undefined)
        getState = s
        setState = set
        // Refetch on session/branch transition AND clear stale state on
        // every transition so a no-data window between sessions never
        // shows the prior session's tasks.
        createEffect(() => {
          const session = transport.currentSession()
          // Clear immediately on key change (or undefined) — `liveTasks`
          // also gates by key, but explicit clear avoids transient
          // mismatched-key state lingering until the next refetch.
          setState(undefined)
          if (session === undefined) return
          void runRefetch(session)
        })
      })
    })

    // Pulse subscription — leak intentional per header note.
    transport.onExtensionStateChanged((p) => {
      if (p.extensionId !== EXT_ID) return
      const session = transport.currentSession()
      if (session === undefined) return
      void runRefetch(session)
    })

    const runningCount = (): number =>
      liveTasks().filter((t) => t.status === "in_progress" || t.status === "pending").length

    const TasksDialogOverlay = (overlayProps: { open: boolean; onClose: () => void }) => (
      <BackgroundTasksDialog
        open={overlayProps.open}
        onClose={overlayProps.onClose}
        tasks={liveTasks()}
      />
    )

    const TrackedTaskWidget = () => {
      const previews = createMemo((): TaskPreview[] =>
        liveTasks().map((t) => ({ subject: t.subject, status: t.status })),
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
