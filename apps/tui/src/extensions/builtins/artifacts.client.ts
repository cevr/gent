/**
 * Artifacts TUI widget — transport-only.
 *
 * Migrated off `ArtifactsPackage.tui` paired-package pattern. The widget owns
 * its own Solid signal inside an Effect-typed setup, fetched via
 * `client.extension.ask` with `ArtifactProtocol.List` and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/artifacts`. Reactive lifecycle is
 * rooted in `createRoot` and disposed when the `clientRuntime` scope
 * finalizes (provider unmount).
 */
import { createSignal, createEffect, createRoot } from "solid-js"
import { Effect } from "effect"
import { borderLabelContribution } from "@gent/core/domain/extension-client.js"
import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import type { Artifact } from "@gent/extensions/artifacts-protocol.js"
import { ArtifactProtocol } from "@gent/extensions/artifacts-protocol.js"
import { ClientTransport } from "../client-transport"

const EXT_ID = "@gent/artifacts"

export default ExtensionPackage.tui(EXT_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport

    // Setup-scoped Solid root — owns the signal + the session/branch
    // refetch effect. `clientRuntime.dispose()` (at provider unmount,
    // see `apps/tui/src/extensions/context.tsx:onCleanup`) does not run
    // detached Solid roots; provider mount is a one-shot lifetime in
    // production so the leak is bounded to app lifetime.
    type RootApi = {
      state: () => readonly Artifact[] | undefined
      setState: (next: readonly Artifact[] | undefined) => void
    }
    const api: RootApi = yield* Effect.sync(() => {
      let captured!: RootApi
      createRoot(() => {
        const [state, setState] = createSignal<readonly Artifact[] | undefined>(undefined)
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
            message: ArtifactProtocol.List({}),
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
        api.setState(reply as readonly Artifact[])
      } catch {
        // Silent — leave last known list.
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
        position: "bottom-right",
        priority: 50,
        produce: () => {
          const items = api.state()
          if (!items || items.length === 0) return []
          const currentBranch = transport.currentSession()?.branchId
          const active = items.filter(
            (a) =>
              a.status === "active" && (a.branchId === undefined || a.branchId === currentBranch),
          ).length
          if (active === 0) return []
          return [
            {
              text: `${active} artifact${active !== 1 ? "s" : ""}`,
              color: "info" as const,
            },
          ]
        },
      }),
    ]
  }),
})
