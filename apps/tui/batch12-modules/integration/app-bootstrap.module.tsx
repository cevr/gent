/* eslint-disable */
/** @jsxImportSource @opentui/solid */
import { describe, it, expect, test } from "effect-bun-test"
import { Effect, Option } from "effect"
import { onMount } from "solid-js"
import { App } from "../../src/app"
import { resolveInitialState, resolveInteractiveBootstrap } from "../../src/app-bootstrap"
import { useRouter, type RouterContextValue } from "../../src/router"
import { useClient } from "../../src/client"
import type { ClientContextValue } from "../../src/client/context"
import { destroyRenderSetup, renderWithProviders } from "../../src/../tests/render-harness"
import { baseLocalLayer as _baseLocalLayer } from "@gent/core/test-utils/in-process-layer.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"
const baseLocalLayer = () =>
  _baseLocalLayer({ agents: AllBuiltinAgents, extraLayers: [GitReader.Test] })
import { Gent } from "@gent/sdk"
import { waitForFrame, repoRoot } from "../../src/../integration/helpers"
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
describe("app bootstrap", () => {
  it.live(
    "continue mode resumes the latest session for cwd",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(baseLocalLayer())
            const first = yield* client.session.create({ cwd: repoRoot })
            yield* Effect.sleep("5 millis")
            const second = yield* client.session.create({ cwd: repoRoot })
            const state = yield* resolveInitialState({
              client,
              cwd: repoRoot,
              session: Option.none(),
              continue_: true,
              headless: false,
              prompt: Option.none(),
              promptArg: Option.none(),
            })
            expect(state._tag).toBe("session")
            if (state._tag !== "session") return
            expect(state.session.id).toBe(second.sessionId)
            expect(state.session.id).not.toBe(first.sessionId)
          }),
        )
      }),
    5000,
  )
  it.live(
    "continue mode creates a session from prompt when none exists",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(baseLocalLayer())
            const state = yield* resolveInitialState({
              client,
              cwd: repoRoot,
              session: Option.none(),
              continue_: true,
              headless: false,
              prompt: Option.some("bootstrap prompt"),
              promptArg: Option.none(),
            })
            expect(state._tag).toBe("session")
            if (state._tag !== "session") return
            expect(state.prompt).toBe("bootstrap prompt")
            expect(state.session.branchId).toBeDefined()
          }),
        )
      }),
    5000,
  )
  it.live(
    "pre-render bootstrap resolves session and agent",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client, runtime } = yield* Gent.test(baseLocalLayer())
            // Simulate what main.tsx now does before render: resolve bootstrap
            const { bootstrap } = yield* resolveInteractiveBootstrap({
              client,
              cwd: repoRoot,
              continue_: false,
              debugMode: false,
            })
            expect(bootstrap.initialSession).toBeDefined()
            expect(bootstrap.initialRoute._tag).toBe("session")
            // Render with pre-resolved state
            let ctx:
              | {
                  client: ClientContextValue
                  router: RouterContextValue
                }
              | undefined
            const setup = yield* Effect.promise(() =>
              renderWithProviders(
                () => (
                  <>
                    <StateProbe
                      onReady={(c) => {
                        ctx = c
                      }}
                    />
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
            expect(ctx).toBeDefined()
            // Route should already be session — no loading transition needed
            expect(ctx!.router.route()._tag).toBe("session")
            // waitForFrame polls until the loading marker clears — no
            // pre-sleep needed.
            const frame = yield* waitForFrame(
              setup,
              (f) => !f.includes("Loading session"),
              "no loading session",
              2000,
            )
            expect(frame).not.toContain("Loading session")
          }),
        )
      }),
    10000,
  )
})
