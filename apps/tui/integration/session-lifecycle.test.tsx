/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { App, resolveInteractiveState, resolveInteractiveBootstrap } from "../src/app"
import { mountClient } from "../tests/render-harness-boundary"
import {
  baseLocalLayer,
  createE2ELayer,
  baseLocalLayerWithProvider as _baseLocalLayerWithProvider,
  LanguageModelLayers,
  testAgent,
} from "@gent/core/test-utils"
import {
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  DEFAULT_MODEL_ID,
  Model,
  ProviderId,
} from "@gent/core/protocol"
import { defineExtension, ExtensionHost } from "@gent/core/extensions/api"
import { Model as AiModel } from "effect/ai"
import { Gent } from "@gent/sdk"
import { repoRoot } from "./helpers"
import { waitForFrame } from "../tests/helpers-boundary"
const baseLocalLayerWithProvider = (p: Parameters<typeof _baseLocalLayerWithProvider>[0]) =>
  _baseLocalLayerWithProvider(p, { agents: [testAgent] })
const localLayer = () => baseLocalLayer({ agents: [testAgent] })
describe("app bootstrap", () => {
  it.live(
    "continue mode resumes the latest session for cwd",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* repoRoot
          const { client } = yield* Gent.test(localLayer())
          const first = yield* client.session.create({ cwd })
          // oxlint-disable-next-line effect/noFixedWaitInTests -- real-clock gap so the second session's createdAt sorts strictly after the first
          yield* Effect.sleep("5 millis")
          const second = yield* client.session.create({ cwd })
          const state = yield* resolveInteractiveState({
            client,
            cwd,
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
          const cwd = yield* repoRoot
          const { client } = yield* Gent.test(localLayer())
          const state = yield* resolveInteractiveState({
            client,
            cwd,
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
  // Bootstrap, render, then a send: the session the bootstrap names shows
  // with no loading route, and the debug model's reply draws.
  it.live(
    "bootstrap to session renders the composer, and a send shows the debug reply",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* repoRoot
          const { client, runtime } = yield* Gent.test(
            baseLocalLayerWithProvider(LanguageModelLayers.debug({ retries: false })),
          )
          // Pre-resolve bootstrap
          const bootstrap = yield* resolveInteractiveBootstrap({
            client,
            cwd,
            continue_: false,
          })
          expect(Option.isNone(bootstrap.initialBranches)).toBe(true)
          const { setup, client: shellClient } = yield* mountClient({
            client,
            runtime,
            initialPrompt: bootstrap.initialPrompt,
            initialSession: bootstrap.initialSession,
            cwd,
            width: 100,
            height: 32,
            view: () => <App />,
          })
          const composer = yield* waitForFrame(
            setup,
            (frame) => frame.includes("ready") || frame.includes("idle") || frame.includes("❯"),
            "composer visible before send",
            3000,
          )
          expect(composer).not.toContain("Loading Gent")
          expect(composer).not.toContain("Loading session")
          // Send a message through the client (simulates user input).
          // The downstream waitForFrame polls until the response arrives;
          // the response itself confirms the feed fiber was subscribed.
          const session = shellClient.session()
          // The shell mounts the session the bootstrap handed it.
          expect(session.sessionId).toBe(bootstrap.initialSession.sessionId)
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

describe("effort command", () => {
  // The model accepts three levels: a level past them is sent clamped.
  const effortModel = Model.make({
    id: DEFAULT_MODEL_ID,
    name: "Effort Model",
    provider: ProviderId.make(DEFAULT_MODEL_ID.split("/")[0] ?? ""),
    contextLength: 128_000,
    reasoning: true,
    efforts: ["low", "medium", "high"],
  })
  // The driver lists the model, so the client's catalog names it; no turn runs.
  const effortDriver = defineExtension({
    id: "effort-driver",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("modelDriver", {
        id: effortModel.provider,
        name: "Effort driver",
        listModels: () => Effect.succeed([effortModel]),
        resolveModel: () =>
          Effect.succeed(
            AiModel.make(effortModel.provider, effortModel.id, LanguageModelLayers.failing),
          ),
      })
    }),
  })

  // The agent's own level: what `default` falls back to.
  const mediumAgent = AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    description: "Test agent at medium effort",
    reasoningEffort: "medium",
  })

  // `/effort off` is `none`, sent as the model's lowest level; `/think` is the
  // old name; `/effort default` clears the session's level. The picker's
  // `default` row names the agent's level, never the session's override.
  it.live(
    "/effort and its /think alias store the session's level, and the status row shows what is sent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* repoRoot
          const { client, runtime } = yield* Gent.test(
            createE2ELayer({
              providerLayer: LanguageModelLayers.debug(),
              agents: [mediumAgent],
              extensionInputs: [effortDriver],
              models: [effortModel],
              toolRunner: "test",
            }),
          )
          const bootstrap = yield* resolveInteractiveBootstrap({ client, cwd, continue_: false })
          const sessionId = bootstrap.initialSession.sessionId
          // A stored key, so the driver needs no sign-in (the layer's own temp home).
          yield* client.auth.setKey({ provider: effortModel.provider, key: "test-key", sessionId })
          const { setup } = yield* mountClient({
            client,
            runtime,
            initialPrompt: bootstrap.initialPrompt,
            initialSession: bootstrap.initialSession,
            cwd,
            width: 100,
            height: 32,
            view: () => <App />,
          })
          const statusRow = (frame: string) =>
            Option.getOrElse(
              Option.fromUndefinedOr(frame.split("\n").find((row) => row.includes("Effort Model"))),
              () => "",
            )
          // The snapshot has landed once the row shows the agent's level.
          yield* waitForFrame(
            setup,
            (frame) => statusRow(frame).includes(" medium"),
            "status row at the agent's level",
            3000,
          )
          const run = (line: string, stored: Option.Option<string>, shown: string) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => setup.mockInput.typeText(line))
              yield* Effect.promise(() => setup.renderOnce())
              setup.mockInput.pressEnter()
              yield* waitForFrame(
                setup,
                (frame) => statusRow(frame).includes(` ${shown}`),
                `status row after ${line}`,
                3000,
              )
              const session = yield* client.session.get({ sessionId })
              const level: Option.Option<string> = Option.fromNullishOr(session?.reasoningLevel)
              expect([line, level]).toEqual([line, stored])
            })
          // The picker's `default` row, read while the picker is open.
          const defaultRow = Effect.gen(function* () {
            yield* Effect.promise(() => setup.mockInput.typeText("/effort"))
            yield* Effect.promise(() => setup.renderOnce())
            setup.mockInput.pressEnter()
            const frame = yield* waitForFrame(
              setup,
              (each) => each.includes("Effort ·"),
              "effort picker",
              3000,
            )
            setup.mockInput.pressEscape()
            yield* waitForFrame(setup, (each) => !each.includes("Effort ·"), "picker closed", 3000)
            return Option.getOrElse(
              Option.fromUndefinedOr(
                frame.split("\n").find((row) => row.includes("agent or config default")),
              ),
              () => "",
            ).trim()
          })
          const agentDefault = /default\s+agent or config default \(medium\)$/
          expect(yield* defaultRow).toMatch(agentDefault)
          yield* run("/effort off", Option.some("none"), "low")
          expect(yield* defaultRow).toMatch(agentDefault)
          yield* run("/think high", Option.some("high"), "high")
          yield* run("/effort max", Option.some("max"), "high")
          yield* run("/effort default", Option.none(), "medium")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15000,
  )
})
