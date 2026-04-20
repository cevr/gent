/**
 * Artifacts TUI widget — transport-only.
 *
 * B11.6: migrated off `ArtifactsPackage.tui` paired-package pattern. The
 * widget owns its own Solid signal inside an Effect-typed setup, fetched
 * via `client.extension.ask` with `ArtifactProtocol.List` and refreshed on
 * `ExtensionStateChanged` pulses for `@gent/artifacts`.
 *
 * Lifecycle: setup runs once per `ExtensionUIProvider` mount via
 * `runtime.runPromise`, which has no lasting scope. The Solid `createRoot`
 * + pulse subscription leak for the lifetime of the provider mount; in
 * production that is the lifetime of the app (one-shot mount). A future
 * remount-capable provider would need a per-extension scope.
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

    type ActiveSession = NonNullable<ReturnType<typeof transport.currentSession>>

    // Keyed state — readers gate on (sid, bid) match against the live
    // session, so a stale list from the prior session never renders.
    type Keyed = {
      readonly sessionId: string
      readonly branchId: string
      readonly items: readonly Artifact[]
    }
    let getState!: () => Keyed | undefined
    let setState!: (next: Keyed | undefined) => void

    const liveItems = (): readonly Artifact[] => {
      const s = getState()
      const cur = transport.currentSession()
      if (s === undefined || cur === undefined) return []
      if (s.sessionId !== cur.sessionId || s.branchId !== cur.branchId) return []
      return s.items
    }

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
        setState({
          sessionId: captured.sessionId,
          branchId: captured.branchId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          items: reply as readonly Artifact[],
        })
      } catch (err) {
        console.warn(
          `[${EXT_ID}] artifact list refresh failed:`,
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
          // Clear stale state on every session transition — `liveItems`
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
        position: "bottom-right",
        priority: 50,
        produce: () => {
          const items = liveItems()
          if (items.length === 0) return []
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
