/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { onMount } from "solid-js"
import { App } from "../src/app"
import { Route, useRouter, type RouterContextValue } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { destroyRenderSetup, renderWithProviders } from "../tests/render-harness"
import { baseLocalLayerWithProvider } from "@gent/core/test-utils/in-process-layer.js"
import { DebugProvider } from "@gent/core/debug/provider.js"
import { Gent } from "@gent/sdk"
import { waitForCondition, waitForFrame, repoRoot } from "./helpers"

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

describe("session lifecycle", () => {
  test("bootstrap to session renders composer", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, runtime } = yield* Gent.test(
            baseLocalLayerWithProvider(DebugProvider({ retries: false })),
          )
          let ctx: { client: ClientContextValue; router: RouterContextValue } | undefined

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <StateProbe onReady={(c) => (ctx = c)} />
                  <App startup={{ cwd: repoRoot, continue_: false }} />
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

          // Wait for bootstrap → session
          yield* waitForCondition(
            setup,
            () => ctx?.router.route()._tag === "session",
            "route = session",
          )

          // Allow auth gate + feed to settle
          yield* Effect.sleep("300 millis")

          // Composer should render with idle status and prompt marker
          const frame = yield* waitForFrame(
            setup,
            (f) => f.includes("ready") || f.includes("idle") || f.includes("❯"),
            "composer visible",
            3_000,
          )
          expect(frame).not.toContain("Loading Gent")
          expect(frame).not.toContain("Loading session")
        }),
      ),
    )
  }, 10_000)

  test("send message and see debug provider response", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, runtime } = yield* Gent.test(
            baseLocalLayerWithProvider(DebugProvider({ retries: false })),
          )
          let ctx: { client: ClientContextValue; router: RouterContextValue } | undefined

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <StateProbe onReady={(c) => (ctx = c)} />
                  <App startup={{ cwd: repoRoot, continue_: false }} />
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

          // Wait for session route
          yield* waitForCondition(
            setup,
            () => ctx?.router.route()._tag === "session",
            "route = session",
          )

          // Allow feed to subscribe
          yield* Effect.sleep("300 millis")

          // Send a message through the client (simulates user input)
          const session = ctx?.client.session()
          expect(session).not.toBeNull()
          if (session === null || session === undefined) return

          yield* client.message.send({
            sessionId: session.sessionId,
            branchId: session.branchId,
            content: "hello world",
          })

          // DebugProvider responds with a message containing the user's text
          // Wait for the response to appear in the rendered frame
          const frame = yield* waitForFrame(
            setup,
            (f) => f.includes("debug response") && f.includes("hello world"),
            "debug provider response",
          )
          expect(frame).toContain("hello world")
        }),
      ),
    )
  }, 10_000)
})
