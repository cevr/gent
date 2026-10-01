/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { onMount } from "solid-js"
import { App, resolveInteractiveState, resolveInteractiveBootstrap } from "../src/app"
import { type ClientContextValue, useClient } from "../src/client"
import { renderScoped } from "../tests/render-harness-boundary"
import {
  baseLocalLayer,
  baseLocalLayerWithProvider as _baseLocalLayerWithProvider,
  LanguageModelLayers,
  testAgent,
} from "@gent/core/test-utils"
import { Gent } from "@gent/sdk"
import { repoRoot } from "./helpers"
import { waitForFrame } from "../tests/helpers-boundary"
const baseLocalLayerWithProvider = (p: Parameters<typeof _baseLocalLayerWithProvider>[0]) =>
  _baseLocalLayerWithProvider(p, { agents: [testAgent] })
const localLayer = () => baseLocalLayer({ agents: [testAgent] })
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
          const { client } = yield* Gent.test(localLayer())
          const first = yield* client.session.create({ cwd: repoRoot })
          // oxlint-disable-next-line effect/noFixedWaitInTests -- real-clock gap so the second session's createdAt sorts strictly after the first
          yield* Effect.sleep("5 millis")
          const second = yield* client.session.create({ cwd: repoRoot })
          const state = yield* resolveInteractiveState({
            client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            prompt: Option.none(),
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
          const { client } = yield* Gent.test(localLayer())
          const state = yield* resolveInteractiveState({
            client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            prompt: Option.some("bootstrap prompt"),
          })
          expect(state._tag).toBe("session")
          if (state._tag !== "session") return
          expect(state.prompt).toBe("bootstrap prompt")
          expect(state.session.activeBranchId).toBeDefined()
        }),
      ),
    5000,
  )
})

describe("session lifecycle", () => {
  it.live(
    "bootstrap to session renders composer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, runtime } = yield* Gent.test(
            baseLocalLayerWithProvider(LanguageModelLayers.debug({ retries: false })),
          )
          let ctx = Option.none<{ client: ClientContextValue }>()
          // Pre-resolve bootstrap (same as main.tsx now does)
          const bootstrap = yield* resolveInteractiveBootstrap({
            client,
            cwd: repoRoot,
            continue_: false,
          })
          expect(bootstrap.initialSession).toBeDefined()
          expect(Option.isNone(bootstrap.initialBranches)).toBe(true)
          const setup = yield* renderScoped(
            () => (
              <>
                <StateProbe onReady={(c) => (ctx = Option.some(c))} />
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
          )
          // Route should already be session
          expect(Option.isSome(ctx)).toBe(true)
          if (Option.isNone(ctx)) return
          // The shell mounts whatever the client says is active; the bootstrap
          // handed it a session, so that is what shows.
          expect(ctx.value.client.session().sessionId).toBe(bootstrap.initialSession.sessionId)
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
      ),
    10000,
  )
  it.live(
    "send message and see debug provider response",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, runtime } = yield* Gent.test(
            baseLocalLayerWithProvider(LanguageModelLayers.debug({ retries: false })),
          )
          let ctx = Option.none<{ client: ClientContextValue }>()
          // Pre-resolve bootstrap
          const bootstrap = yield* resolveInteractiveBootstrap({
            client,
            cwd: repoRoot,
            continue_: false,
          })
          const setup = yield* renderScoped(
            () => (
              <>
                <StateProbe onReady={(c) => (ctx = Option.some(c))} />
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
          )
          yield* waitForFrame(
            setup,
            (frame) => frame.includes("ready") || frame.includes("idle") || frame.includes("❯"),
            "composer visible before send",
            3000,
          )
          // Send a message through the client (simulates user input).
          // The downstream waitForFrame polls until the response arrives;
          // the response itself confirms the feed fiber was subscribed.
          expect(Option.isSome(ctx)).toBe(true)
          if (Option.isNone(ctx)) return
          const session = ctx.value.client.session()
          yield* client.message
            .send({
              sessionId: session.sessionId,
              branchId: session.branchId,
              content: "hello world",
            })
            .pipe(
              Effect.timeout("2 seconds"),
              Effect.mapError((error) => `message.send boundary: ${String(error)}`),
            )
          // `LanguageModelLayers.debug` responds with a message containing the user's text
          // Wait for the response to appear in the rendered frame
          const frame = yield* waitForFrame(
            setup,
            (f) => f.includes("debug response") && f.includes("hello world"),
            "debug provider response",
            3000,
          ).pipe(
            Effect.timeout("4 seconds"),
            Effect.mapError((error) => `render/frame boundary: ${String(error)}`),
          )
          expect(frame).toContain("hello world")
        }),
      ),
    10000,
  )
})
