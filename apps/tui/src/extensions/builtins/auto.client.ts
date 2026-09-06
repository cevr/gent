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
import { Effect, Option, Predicate } from "effect"
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
import { ClientShell, ClientLifecycle, makeClientSessionResource } from "../client-services"

const EXT_ID = String(AUTO_EXTENSION_ID)

export default defineClientExtension(EXT_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    const modelResource = yield* makeClientSessionResource<AutoSnapshotReplyType>({
      transport,
      lifecycle,
      cast: shell.cast,
      label: `${EXT_ID} auto snapshot`,
      fetch: (session) => requestExtension(ref(AutoRpc.GetSnapshot), {}, transport, session),
      subscribe: (refetch) =>
        transport.onExtensionStateChanged((p) => {
          if (p.extensionId === EXT_ID) refetch()
        }),
    })
    const liveModel = modelResource.read

    return clientContributions(
      borderLabelContribution({
        position: "top-left",
        priority: 20,
        produce: () => {
          const model = Option.fromNullishOr(liveModel())
          if (Option.isNone(model) || !model.value.active) return []
          let phase: "review" | "auto" = "auto"
          if (model.value.phase === "awaiting-review") phase = "review"
          const iteration = Option.fromNullishOr(model.value.iteration)
          let iter = ""
          if (Option.isSome(iteration)) {
            const maxIterations = Option.getOrElse(
              Option.fromNullishOr(model.value.maxIterations),
              () => "?",
            )
            iter = ` ${iteration.value}/${maxIterations}`
          }
          let color: "warning" | "info" = "info"
          if (model.value.phase === "awaiting-review") color = "warning"
          return [
            {
              text: `${phase}${iter}`,
              color,
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
          const model = Option.fromNullishOr(liveModel())
          if (Option.isSome(model) && model.value.active) {
            void shell.run(
              requestExtension(ref(AutoRpc.CancelAuto), {}, transport).pipe(
                Effect.catchEager((err) => {
                  let error = String(err)
                  if (Predicate.isError(err)) error = err.message
                  return Effect.logWarning(`[${EXT_ID}] auto cancel failed`).pipe(
                    Effect.annotateLogs({ error }),
                  )
                }),
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
