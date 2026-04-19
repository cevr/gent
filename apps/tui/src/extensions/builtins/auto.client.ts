/**
 * Auto-loop TUI widget — transport-only.
 *
 * Migrated off `AutoPackage.tui` paired-package pattern. The widget owns its
 * own Solid signal inside an Effect-typed setup, fetched via
 * `client.extension.ask` with `AutoProtocol.GetSnapshot` and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/auto`. Reactive lifecycle is
 * rooted in `createRoot` and disposed when the `clientRuntime` scope
 * finalizes (provider unmount).
 */
import { createSignal, createEffect, createRoot } from "solid-js"
import { Effect } from "effect"
import {
  borderLabelContribution,
  clientCommandContribution,
  overlayContribution,
} from "@gent/core/domain/extension-client.js"
import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import type { AutoSnapshotReply } from "@gent/extensions/auto-protocol.js"
import { AutoProtocol } from "@gent/extensions/auto-protocol.js"
import { AutoGoalOverlay } from "../auto-goal-overlay"
import { ClientTransport } from "../client-transport"
import { ClientShell } from "../client-services"

const EXT_ID = "@gent/auto"

export default ExtensionPackage.tui(EXT_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell

    // Setup-scoped Solid root — owns the signal + the session/branch
    // refetch effect. `clientRuntime.dispose()` (at provider unmount,
    // see `apps/tui/src/extensions/context.tsx:onCleanup`) does not run
    // detached Solid roots; provider mount is a one-shot lifetime in
    // production so the leak is bounded to app lifetime.
    type RootApi = {
      state: () => AutoSnapshotReply | undefined
      setState: (next: AutoSnapshotReply | undefined) => void
    }
    const api: RootApi = yield* Effect.sync(() => {
      let captured!: RootApi
      createRoot(() => {
        const [state, setState] = createSignal<AutoSnapshotReply | undefined>(undefined)
        captured = { state, setState }
        createEffect(() => {
          const session = transport.currentSession()
          if (session === undefined) {
            setState(undefined)
            return
          }
          void runRefetch(session)
        })
      })
      return captured
    })

    type ActiveSession = NonNullable<ReturnType<typeof transport.currentSession>>
    const runRefetch = async (captured: ActiveSession): Promise<void> => {
      try {
        const reply = await transport.runtime.run(
          transport.client.extension.ask({
            sessionId: captured.sessionId,
            message: AutoProtocol.GetSnapshot(),
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        api.setState(reply as AutoSnapshotReply)
      } catch {
        // Silent — leave last known state.
      }
    }

    const unsub = transport.onExtensionStateChanged((p) => {
      if (p.extensionId !== EXT_ID) return
      const session = transport.currentSession()
      if (session === undefined) return
      void runRefetch(session)
    })
    // Same one-shot lifetime — see note above.
    void unsub // mark as intentionally unused

    return [
      borderLabelContribution({
        position: "top-left",
        priority: 20,
        produce: () => {
          const model = api.state()
          if (!model?.active) return []
          const phase = model.phase === "awaiting-review" ? "review" : "auto"
          const iter =
            model.iteration !== undefined ? ` ${model.iteration}/${model.maxIterations ?? "?"}` : ""
          return [
            {
              text: `${phase}${iter}`,
              color: model.phase === "awaiting-review" ? "warning" : "info",
            },
          ]
        },
      }),
      overlayContribution({
        id: "auto-goal",
        component: AutoGoalOverlay,
      }),
      clientCommandContribution({
        id: "auto.toggle",
        title: "Toggle Auto Mode",
        category: "Auto",
        keybind: "shift+tab",
        slash: "auto",
        onSelect: () => {
          const model = api.state()
          if (model?.active) {
            shell.send(AutoProtocol.CancelAuto())
          } else {
            shell.openOverlay("auto-goal")
          }
        },
      }),
    ]
  }),
})
