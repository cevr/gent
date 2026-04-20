/**
 * Auto-loop TUI widget — transport-only.
 *
 * B11.6: migrated off `AutoPackage.tui` paired-package pattern. The widget
 * owns its own Solid signal inside an Effect-typed setup, fetched via
 * `client.extension.ask` with `AutoProtocol.GetSnapshot` and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/auto`.
 *
 * Lifecycle: setup runs once per `ExtensionUIProvider` mount via
 * `runtime.runPromise`, which has no lasting scope. The Solid `createRoot`
 * + pulse subscription leak for the lifetime of the provider mount; in
 * production that is the lifetime of the app (one-shot mount). A future
 * remount-capable provider would need a per-extension scope.
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

    type ActiveSession = NonNullable<ReturnType<typeof transport.currentSession>>

    // Keyed state — the readers gate on (sid, bid) match against the live
    // session, so a stale model from the prior session never renders or
    // drives commands like /auto cancel.
    type Keyed = {
      readonly sessionId: string
      readonly branchId: string
      readonly model: AutoSnapshotReply
    }
    let getState!: () => Keyed | undefined
    let setState!: (next: Keyed | undefined) => void

    const liveModel = (): AutoSnapshotReply | undefined => {
      const s = getState()
      const cur = transport.currentSession()
      if (s === undefined || cur === undefined) return undefined
      if (s.sessionId !== cur.sessionId || s.branchId !== cur.branchId) return undefined
      return s.model
    }

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
        setState({
          sessionId: captured.sessionId,
          branchId: captured.branchId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          model: reply as AutoSnapshotReply,
        })
      } catch (err) {
        console.warn(
          `[${EXT_ID}] auto snapshot refresh failed:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    yield* Effect.sync(() => {
      createRoot(() => {
        const [s, set] = createSignal<Keyed | undefined>(undefined)
        getState = s
        setState = set
        createEffect(() => {
          const session = transport.currentSession()
          // Clear stale state on every session transition — `liveModel`
          // also gates by key, but explicit clear avoids transient
          // mismatched-key state.
          setState(undefined)
          if (session === undefined) return
          void runRefetch(session)
        })
      })
    })

    transport.onExtensionStateChanged((p) => {
      if (p.extensionId !== EXT_ID) return
      const session = transport.currentSession()
      if (session === undefined) return
      void runRefetch(session)
    })

    return [
      borderLabelContribution({
        position: "top-left",
        priority: 20,
        produce: () => {
          const model = liveModel()
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
          const model = liveModel()
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
