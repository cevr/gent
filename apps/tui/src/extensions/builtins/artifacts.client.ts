/**
 * Artifacts TUI widget — transport-only.
 *
 * Transport-only widget. The widget owns its own Solid signal inside an
 * Effect-typed setup, fetched
 * via `requestExtension(ref(ArtifactRpc.List))` and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/artifacts`.
 *
 * Lifecycle: setup runs once per `ExtensionUIProvider` mount via
 * `runtime.runPromise`. The Solid `createRoot` disposer and the pulse
 * unsubscribe are registered with `ClientLifecycle.addCleanup`; the
 * provider's `onCleanup` runs them when it unmounts, so this widget
 * leaves no detached root behind.
 */
import { Effect, Option } from "effect"
import { ref } from "@gent/core/extensions/api"
import { defineClientExtension, borderLabelContribution } from "../client-facets.js"
import { ArtifactRpc, type ArtifactType } from "@gent/extensions/client.js"
import { requestExtension, ClientTransport } from "../client-transport"
import { ClientLifecycle, ClientShell, makeClientSessionResource } from "../client-services"

const EXT_ID = "@gent/artifacts"

export default defineClientExtension(EXT_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    const itemsResource = yield* makeClientSessionResource<readonly ArtifactType[]>({
      transport,
      lifecycle,
      cast: shell.cast,
      label: `${EXT_ID} artifact list`,
      fetch: (session) => requestExtension(ref(ArtifactRpc.List), {}, transport, session),
      subscribe: (refetch) =>
        transport.onExtensionStateChanged((p) => {
          if (p.extensionId === EXT_ID) refetch()
        }),
    })
    const liveItems = (): readonly ArtifactType[] =>
      Option.getOrElse(Option.fromNullishOr(itemsResource.read()), () => [])

    return borderLabelContribution({
      position: "bottom-right",
      priority: 50,
      produce: () => {
        const items = liveItems()
        if (items.length === 0) return []
        const currentBranch = Option.fromNullishOr(transport.currentSession()).pipe(
          Option.map((session) => session.branchId),
        )
        const active = items.filter((artifact) => {
          if (artifact.status !== "active") return false
          const branchId = Option.fromNullishOr(artifact.branchId)
          if (Option.isNone(branchId)) return true
          return Option.contains(currentBranch, branchId.value)
        }).length
        if (active === 0) return []
        let suffix = "s"
        if (active === 1) suffix = ""
        return [
          {
            text: `${active} artifact${suffix}`,
            color: "info",
          },
        ]
      },
    })
  }),
})
