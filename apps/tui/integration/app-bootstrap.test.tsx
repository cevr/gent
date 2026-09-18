/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { onMount } from "solid-js"
import { App } from "../src/app"
import { resolveInitialState, resolveInteractiveBootstrap } from "../src/app-bootstrap"
import { type ClientContextValue, useClient } from "../src/client"
import { destroyRenderSetup, renderWithProviders } from "../tests/render-harness-boundary"
import { baseLocalLayer as _baseLocalLayer } from "@gent/core-internal/test-utils/in-process-layer.js"
import { AllBuiltinAgents } from "../../../packages/extensions/tests/helpers/builtin-agents.js"
const baseLocalLayer = () => _baseLocalLayer({ agents: AllBuiltinAgents })
import { Gent } from "@gent/sdk"
import { waitForFrame, repoRoot } from "./helpers"
function StateProbe(props: { readonly onReady: (ctx: { client: ClientContextValue }) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady({ client })
  })
  return <box />
}
describe("app bootstrap", () => {
  it.live(
    "continue mode resumes the latest session for cwd",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* Gent.test(baseLocalLayer())
          const first = yield* client.session.create({ cwd: repoRoot })
          // gent/no-sleep: allow real-clock gap so the second session's createdAt sorts strictly after the first
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
      ),
    5000,
  )
  it.live(
    "continue mode creates a session from prompt when none exists",
    () =>
      Effect.scoped(
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
          expect(state.session.activeBranchId).toBeDefined()
        }),
      ),
    5000,
  )
  it.live(
    "pre-render bootstrap resolves session and agent",
    () =>
      Effect.scoped(
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
          expect(Option.isNone(bootstrap.initialBranches)).toBe(true)
          // Render with pre-resolved state
          let ctx = Option.none<{ client: ClientContextValue }>()
          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => (
                <>
                  <StateProbe
                    onReady={(c) => {
                      ctx = Option.some(c)
                    }}
                  />
                  <App />
                </>
              ),
              {
                client,
                runtime,
                initialPrompt: bootstrap.initialPrompt,
                initialSession: bootstrap.initialSession,
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))
          expect(Option.isSome(ctx)).toBe(true)
          if (Option.isNone(ctx)) return
          // Route should already be session — no loading transition needed
          // The shell mounts whatever the client says is active; the bootstrap
          // handed it a session, so that is what shows.
          expect(Option.isSome(Option.fromNullishOr(ctx.value.client.session()))).toBe(true)
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
      ),
    10000,
  )
})
