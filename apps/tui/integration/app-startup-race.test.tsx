/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { onMount } from "solid-js"
import { App } from "../src/app"
import { Route, useRouter, type RouterContextValue } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { destroyRenderSetup, renderFrame, renderWithProviders } from "../tests/render-harness"
import { baseLocalLayer } from "@gent/core/test-utils/in-process-layer.js"
import { Gent } from "@gent/sdk"

const repoRoot = path.resolve(import.meta.dir, "../../..")

function StateProbe(props: {
  readonly onReady: (ctx: { client: ClientContextValue; router: RouterContextValue }) => void
}) {
  const client = useClient()
  const router = useRouter()
  onMount(() => {
    props.onReady({ client, router })
  })
  return <box />
}

/* eslint-disable no-await-in-loop -- intentional polling loop */
const waitForCondition = async (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await setup.renderOnce()
    await Promise.resolve()
    await setup.renderOnce()
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for condition: ${label}`)
}
/* eslint-enable no-await-in-loop */

describe("app startup race", () => {
  test("bootstrap navigates to session route without auth gate blocking", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, runtime } = yield* Gent.test(baseLocalLayer())
          let ctx: { client: ClientContextValue; router: RouterContextValue } | undefined

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <StateProbe
                    onReady={(c) => {
                      ctx = c
                    }}
                  />
                  <App
                    startup={{
                      cwd: repoRoot,
                      continue_: false,
                    }}
                  />
                </>
              ),
              {
                client,
                runtime,
                initialRoute: Route.loading(),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          expect(ctx).toBeDefined()

          // Wait for bootstrap to complete — route transitions from "loading" to "session"
          yield* Effect.promise(() =>
            waitForCondition(
              setup,
              () => ctx!.router.route()._tag === "session",
              "route = session",
              5_000,
            ),
          )

          expect(ctx!.router.route()._tag).toBe("session")
          // Agent should be set (not undefined) after bootstrap
          expect(ctx!.client.agent()).toBeDefined()

          // Allow auth gate RPC to complete through Effect runtime
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)))

          // After settling, the session view should appear (not "Loading session…")
          yield* Effect.promise(() =>
            waitForCondition(
              setup,
              () => !renderFrame(setup).includes("Loading session"),
              "no loading session",
              2_000,
            ),
          )

          const frame = renderFrame(setup)
          expect(frame).not.toContain("Loading session")
        }),
      ),
    )
  }, 10_000)
})
