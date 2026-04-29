/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { onMount } from "solid-js"
import { App } from "../../src/app"
import { resolveInteractiveBootstrap } from "../../src/app-bootstrap"
import { useRouter, type RouterContextValue } from "../../src/router"
import { useClient } from "../../src/client"
import type { ClientContextValue } from "../../src/client/context"
import { destroyRenderSetup, renderWithProviders } from "../../src/../tests/render-harness"
import { baseLocalLayerWithProvider as _baseLocalLayerWithProvider } from "@gent/core/test-utils/in-process-layer.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"
import { Provider } from "@gent/core/providers/provider.js"
import { Gent } from "@gent/sdk"
import { waitForFrame, repoRoot } from "../../src/../integration/helpers"
const baseLocalLayerWithProvider = (p: Parameters<typeof _baseLocalLayerWithProvider>[0]) =>
  _baseLocalLayerWithProvider(p, { agents: AllBuiltinAgents, extraLayers: [GitReader.Test] })
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
  it.live(
    "bootstrap to session renders composer",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client, runtime } = yield* Gent.test(
              baseLocalLayerWithProvider(Provider.Debug({ retries: false })),
            )
            let ctx:
              | {
                  client: ClientContextValue
                  router: RouterContextValue
                }
              | undefined
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
            // waitForFrame polls until the composer renders — no pre-sleep
            // needed; the visible "ready/idle/❯" marker is the readiness signal.
            const frame = yield* waitForFrame(
              setup,
              (f) => f.includes("ready") || f.includes("idle") || f.includes("❯"),
              "composer visible",
              3000,
            )
            expect(frame).not.toContain("Loading Gent")
            expect(frame).not.toContain("Loading session")
          }),
        )
      }),
    10000,
  )
  it.live(
    "send message and see debug provider response",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client, runtime } = yield* Gent.test(
              baseLocalLayerWithProvider(Provider.Debug({ retries: false })),
            )
            let ctx:
              | {
                  client: ClientContextValue
                  router: RouterContextValue
                }
              | undefined
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
            // Send a message through the client (simulates user input).
            // The downstream waitForFrame polls until the response arrives;
            // the response itself confirms the feed fiber was subscribed.
            const session = ctx?.client.session()
            expect(session).not.toBeNull()
            if (session === null || session === undefined) return
            yield* client.message.send({
              sessionId: session.sessionId,
              branchId: session.branchId,
              content: "hello world",
            })
            // `Provider.Debug` responds with a message containing the user's text
            // Wait for the response to appear in the rendered frame
            const frame = yield* waitForFrame(
              setup,
              (f) => f.includes("debug response") && f.includes("hello world"),
              "debug provider response",
            )
            expect(frame).toContain("hello world")
          }),
        )
      }),
    10000,
  )
})
