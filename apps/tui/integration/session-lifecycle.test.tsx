/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { onMount } from "solid-js"
import { App } from "../src/app"
import { resolveInteractiveBootstrap } from "../src/app-bootstrap"
import { useRouter, type RouterContextValue } from "../src/router"
import { useClient } from "../src/client"
import type { ClientContextValue } from "../src/client/context"
import { destroyRenderSetup, renderWithProviders } from "../tests/render-harness"
import { baseLocalLayerWithProvider } from "@gent/core/test-utils/in-process-layer.js"
import { DebugProvider } from "@gent/core/debug/provider.js"
import { Gent } from "@gent/sdk"
import { waitForFrame, repoRoot } from "./helpers"

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

          // Pre-resolve bootstrap (same as main.tsx now does)
          const { bootstrap } = yield* resolveInteractiveBootstrap({
            client,
            cwd: repoRoot,
            continue_: false,
            debugMode: false,
          })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <StateProbe onReady={(c) => (ctx = c)} />
                  <App />
                </>
              ),
              {
                client,
                runtime,
                initialRoute: bootstrap.initialRoute,
                initialSession: bootstrap.initialSession
                  ? {
                      id: bootstrap.initialSession.sessionId,
                      name: bootstrap.initialSession.name,
                      cwd: repoRoot,
                      branchId: bootstrap.initialSession.branchId,
                      reasoningLevel: bootstrap.initialSession.reasoningLevel,
                      parentSessionId: undefined,
                      parentBranchId: undefined,
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                    }
                  : undefined,
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          // Route should already be session
          expect(ctx?.router.route()._tag).toBe("session")

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

          // Pre-resolve bootstrap
          const { bootstrap } = yield* resolveInteractiveBootstrap({
            client,
            cwd: repoRoot,
            continue_: false,
            debugMode: false,
          })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <StateProbe onReady={(c) => (ctx = c)} />
                  <App />
                </>
              ),
              {
                client,
                runtime,
                initialRoute: bootstrap.initialRoute,
                initialSession: bootstrap.initialSession
                  ? {
                      id: bootstrap.initialSession.sessionId,
                      name: bootstrap.initialSession.name,
                      cwd: repoRoot,
                      branchId: bootstrap.initialSession.branchId,
                      reasoningLevel: bootstrap.initialSession.reasoningLevel,
                      parentSessionId: undefined,
                      parentBranchId: undefined,
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                    }
                  : undefined,
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

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
