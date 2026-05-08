/**
 * Auto-loop TUI widget — transport-only.
 *
 * Transport-only widget. The widget owns its own Solid signal inside an
 * Effect-typed setup, fetched via
 * `requestExtension(ref(AutoRpc.GetSnapshot))` and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/auto`.
 *
 * Lifecycle: setup runs once per `ExtensionUIProvider` mount via
 * `runtime.runPromise`. The Solid `createRoot` disposer and the pulse
 * unsubscribe are registered with `ClientLifecycle.addCleanup`; the
 * provider's `onCleanup` runs them when it unmounts, so this widget
 * leaves no detached root behind.
 */
import { createSignal, createEffect, createRoot } from "solid-js"
import { Effect } from "effect"
import { ref } from "@gent/core/extensions/api"
import {
  defineClientExtension,
  borderLabelContribution,
  clientContributions,
  clientCommandContribution,
  overlayContribution,
} from "../client-facets.js"
import { AUTO_EXTENSION_ID, AutoRpc, type AutoSnapshotReplyType } from "@gent/extensions/client.js"
import { AutoGoalOverlay } from "../auto-goal-overlay"
import { requestExtension, ClientTransport } from "../client-transport"
import { ClientShell, ClientLifecycle } from "../client-services"

const EXT_ID = String(AUTO_EXTENSION_ID)

export default defineClientExtension(EXT_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    type ActiveSession = NonNullable<ReturnType<typeof transport.currentSession>>

    // Keyed state — the readers gate on (sid, bid) match against the live
    // session, so a stale model from the prior session never renders or
    // drives commands like /auto cancel.
    type Keyed = {
      readonly sessionId: string
      readonly branchId: string
      readonly model: AutoSnapshotReplyType
    }
    let getState!: () => Keyed | undefined
    let setState!: (next: Keyed | undefined) => void

    const liveModel = (): AutoSnapshotReplyType | undefined => {
      const s = getState()
      const cur = transport.currentSession()
      if (s === undefined || cur === undefined) return undefined
      if (s.sessionId !== cur.sessionId || s.branchId !== cur.branchId) return undefined
      return s.model
    }

    const runRefetch = (captured: ActiveSession): void => {
      transport.cast(
        Effect.gen(function* () {
          const reply = yield* requestExtension(ref(AutoRpc.GetSnapshot), {}, transport, captured)
          yield* Effect.sync(() => {
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
              model: reply,
            })
          })
        }).pipe(
          Effect.catchEager((err) =>
            Effect.logWarning(`${EXT_ID} auto snapshot refresh failed`).pipe(
              Effect.annotateLogs({ error: String(err) }),
            ),
          ),
        ),
      )
    }

    yield* Effect.sync(() => {
      createRoot((dispose) => {
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
          runRefetch(session)
        })
        lifecycle.addCleanup(dispose)
      })
    })

    const unsubscribePulse = transport.onExtensionStateChanged((p) => {
      if (p.extensionId !== EXT_ID) return
      const session = transport.currentSession()
      if (session === undefined) return
      runRefetch(session)
    })
    lifecycle.addCleanup(unsubscribePulse)

    return clientContributions(
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
            void transport.run(
              requestExtension(ref(AutoRpc.CancelAuto), {}, transport).pipe(
                Effect.catchEager((err: unknown) =>
                  Effect.logWarning(`[${EXT_ID}] auto cancel failed`).pipe(
                    Effect.annotateLogs({
                      error: err instanceof Error ? err.message : String(err),
                    }),
                  ),
                ),
              ),
            )
          } else {
            shell.openOverlay("auto-goal")
          }
        },
      }),
    )
  }),
})
