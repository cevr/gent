/**
 * @gent/guard: rules, the read-only pass and the classifier judge each call
 * through the `toolCall` hook. The classifier is a scripted decision model
 * behind a test driver: no test reaches a provider.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Layer, Option, Path, Predicate, Schema, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { DecisionModel } from "effect/ai"
import type * as Prompt from "effect/ai/Prompt"
import {
  defineExtension,
  ExtensionHost,
  Model,
  ModelId,
  type ModelDriverContribution,
  ProviderId,
  tool,
} from "@gent/core/extensions/api"
import { type AgentEvent, messagePartsText } from "@gent/core/protocol"
import {
  ApprovalService,
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  type SequenceStep,
  testAgent,
  testTurnExtension,
  textStep,
  toolCallStep,
} from "@gent/core/test-utils"
import { callSubject, callText, makeGuardExtension } from "../src/guard.js"
import { encodeExternalJson } from "./helpers/external-wire.js"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const encodeDecisions = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

// ── classifier ──────────────────────────────────────────────────────────────

/** What the scripted classifier does on one call: answer a label, fail, or never answer. */
const JudgeAnswer = Schema.TaggedUnion({
  Label: { label: Schema.String, confidence: Schema.Finite },
  Fail: {},
  Hang: {},
})
type JudgeAnswer = typeof JudgeAnswer.Type

const label = (value: string, confidence = 0.9): JudgeAnswer =>
  JudgeAnswer.cases.Label.make({ label: value, confidence })

/** What the classifier was asked: the model, the decisions (the prefix) and the input. */
interface JudgeCall {
  readonly model: string
  readonly decisions: string
  readonly state: string
}

/**
 * A classifier driver, `guard-judge`, with one model. Call `n` answers
 * `answers[n]` (the last answer after the list); `calls` records each one.
 */
const judgeExtension = (answers: ReadonlyArray<JudgeAnswer>, calls: Array<JudgeCall>) => {
  const driver: ModelDriverContribution = {
    id: "guard-judge",
    name: "Guard judge",
    envCredential: "GENT_TEST_GUARD_JUDGE_KEY_NEVER_SET",
    resolveModel: () => Effect.die("the guard judge serves classifiers only"),
    listModels: () =>
      Effect.succeed([
        Model.make({
          id: ModelId.make("guard-judge/jev"),
          name: "jev",
          provider: ProviderId.make("guard-judge"),
          kind: "classifier",
          pricing: { input: 0.1, output: 0.1 },
        }),
      ]),
    resolveDecisionModel: (modelName) =>
      Effect.succeed(
        Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: (options) =>
              Effect.suspend(() => {
                const answer = answers[calls.length] ?? answers.at(-1) ?? label("allow")
                calls.push({
                  model: modelName,
                  decisions: encodeDecisions(options.decisions),
                  state: encodeJson(options.state),
                })
                if (answer._tag === "Fail") return Effect.die("the classifier is down")
                if (answer._tag === "Hang") return Effect.never
                const labels = ["allow", "ask", "deny", answer.label]
                return Effect.succeed({
                  answers: {
                    verdict: {
                      _tag: "Classify" as const,
                      label: answer.label,
                      probabilities: Object.fromEntries(
                        labels.map((entry) => [entry, Number(entry === answer.label)]),
                      ),
                      confidence: answer.confidence,
                    },
                  },
                  usage: { inputTokens: 21, outputTokens: 0 },
                })
              }),
          }),
        ),
      ),
  }
  return defineExtension({
    id: "guard-judge",
    setup: Effect.gen(function* () {
      yield* (yield* ExtensionHost).register("modelDriver", driver)
    }),
  })
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** `run` (a command tool) records each command it runs; `peek` is read-only. */
const toolsExtension = (ran: Array<string>) =>
  defineExtension({
    id: "guard-tools",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "tool",
        tool({
          id: "run",
          description: "Run a command",
          params: Schema.Struct({ command: Schema.String }),
          output: Schema.String,
          execute: ({ command }) =>
            Effect.sync(() => {
              ran.push(command)
              return `ran ${command}`
            }),
        }),
      )
      yield* host.register(
        "tool",
        tool({
          id: "peek",
          description: "Read a path",
          params: Schema.Struct({ path: Schema.String }),
          output: Schema.String,
          readonly: true,
          execute: ({ path }) =>
            Effect.sync(() => {
              ran.push(`peek ${path}`)
              return `read ${path}`
            }),
        }),
      )
    }),
  })

/** A home whose `~/.gent/config.json` holds `guard` (none: no entry), and a project directory. */
const writeHome = Effect.fn("test.writeHome")(function* (guard: Option.Option<unknown>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* makeTempDirectoryScoped("gent-guard-home-")
  const cwd = yield* makeTempDirectoryScoped("gent-guard-cwd-")
  yield* fs.makeDirectory(path.join(home, ".gent"), { recursive: true })
  const config = Option.match(guard, { onNone: () => ({}), onSome: (value) => ({ guard: value }) })
  yield* fs.writeFileString(path.join(home, ".gent", "config.json"), encodeExternalJson(config))
  return { home, cwd }
})

const POLICY = "Allow reading. Ask before installing packages. Deny deleting files."

/**
 * A session guarded by `guard` (the `guard` config entry), with the scripted
 * classifier, the two tools, and the model's `steps`. `run` sends one message,
 * answers each dialog with `approved`, and returns the turn's events and
 * tool results.
 */
const guardedSession = Effect.fn("test.guardedSession")(function* (params: {
  readonly guard: Option.Option<unknown>
  readonly answers: ReadonlyArray<JudgeAnswer>
  readonly steps: ReadonlyArray<SequenceStep>
  readonly deadlineMs?: number
}) {
  const { home, cwd } = yield* writeHome(params.guard)
  const ran: Array<string> = []
  const calls: Array<JudgeCall> = []
  const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(params.steps)
  const harness = yield* createRpcHarness({
    agents: [testAgent],
    extensionInputs: [
      testTurnExtension,
      toolsExtension(ran),
      judgeExtension(params.answers, calls),
      makeGuardExtension(params.deadlineMs ?? 5_000),
    ],
    providerLayer,
    approvalLayer: ApprovalService.Live,
    home,
    cwd,
  })
  const { client, sessionId, branchId } = harness
  yield* client.auth.setKey({ provider: "guard-judge", key: "test-key", sessionId })
  const run = (content: string, approved: boolean) =>
    Effect.gen(function* () {
      const turn = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.map((envelope) => envelope.event),
        Stream.tap((event) => {
          if (event._tag !== "InteractionPresented") return Effect.void
          return client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: event.requestId,
            approved,
          })
        }),
        Stream.takeUntil(Predicate.isTagged("TurnCompleted")),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* client.message.send({ sessionId, branchId, content })
      const events = Array.from(yield* Fiber.join(turn))
      const messages = yield* client.message.list({ branchId })
      const results = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool-result")
      const answered = messages.some(
        (message) => message.role === "assistant" && messagePartsText(message.parts) === "finished",
      )
      return { events, results, answered }
    })
  return { ran, calls, controls, run }
})

const presentedTexts = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => {
    if (event._tag !== "InteractionPresented") return []
    return [event.text]
  })

const ErrorResult = Schema.Struct({ error: Schema.String })

/** Each result as its failure text, or `ok` for a result that did not fail. */
const outcomes = (results: ReadonlyArray<Prompt.ToolResultPart>) =>
  results.map((part) => {
    if (!part.isFailure) return "ok"
    return Schema.decodeUnknownSync(ErrorResult)(part.result).error
  })

const runCall = (command: string) => toolCallStep("run", { command })

const platform = BunServices.layer

// ── tests ───────────────────────────────────────────────────────────────────

describe("@gent/guard", () => {
  it.scopedLive(
    "with no guard entry in the config the guard judges nothing: no model call, no dialog",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.none(),
          answers: [label("deny")],
          steps: [runCall("rm -rf build"), textStep("finished")],
        })
        const { events, results, answered } = yield* session.run("Clean.", false)
        expect(outcomes(results)).toEqual(["ok"])
        expect(session.ran).toEqual(["rm -rf build"])
        expect(presentedTexts(events)).toEqual([])
        expect(session.calls).toEqual([])
        expect(answered).toBe(true)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )

  it.scopedLive(
    "a rule decides without a model call, and the last rule that matches wins",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.some({
            policy: POLICY,
            rules: [
              { tool: "run", effect: "deny" },
              { tool: "run", match: "git *", effect: "allow" },
              { tool: "r?n", match: "git push *", effect: "deny" },
            ],
          }),
          answers: [label("allow")],
          steps: [
            runCall("git status"),
            runCall("git push --force"),
            runCall("make"),
            textStep("finished"),
          ],
        })
        const { results, answered } = yield* session.run("Ship it.", true)
        const [status, push, make] = outcomes(results)
        expect(status).toBe("ok")
        expect(push).toContain('the guard rule "r?n" matching "git push *" denies it')
        expect(make).toContain('the guard rule "run" denies it')
        expect(session.ran).toEqual(["git status"])
        expect(session.calls).toEqual([])
        expect(answered).toBe(true)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )

  it.scopedLive(
    "a read-only tool runs without a model call",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.some({ policy: POLICY }),
          answers: [label("deny")],
          steps: [toolCallStep("peek", { path: "README.md" }), textStep("finished")],
        })
        const { results } = yield* session.run("Read the readme.", false)
        expect(outcomes(results)).toEqual(["ok"])
        expect(session.ran).toEqual(["peek README.md"])
        expect(session.calls).toEqual([])
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )

  it.scopedLive(
    "the classifier's allow runs the call, its deny fails it, and its ask shows a dialog",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.some({ policy: POLICY, model: "guard-judge/jev" }),
          answers: [label("allow"), label("deny"), label("ask")],
          steps: [
            runCall("ls"),
            runCall("rm notes.txt"),
            runCall("npm install left-pad"),
            textStep("finished"),
          ],
        })
        const { events, results, answered } = yield* session.run("Tidy up.", false)
        const [listed, removed, installed] = outcomes(results)
        expect(listed).toBe("ok")
        expect(removed).toContain("the guard policy forbids it (guard-judge/jev, 0.90)")
        expect(installed).toContain("was not approved and did not run")
        expect(installed).toContain("the guard policy asks about it")
        expect(presentedTexts(events)).toHaveLength(1)
        expect(presentedTexts(events)[0]).toContain("npm install left-pad")
        expect(session.ran).toEqual(["ls"])
        expect(session.calls.map((call) => call.model)).toEqual(["jev", "jev", "jev"])
        expect(answered).toBe(true)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )

  it.scopedLive(
    "a classifier that fails or does not answer in time asks, and an approval runs the call",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.some({ policy: POLICY }),
          answers: [JudgeAnswer.cases.Fail.make({}), JudgeAnswer.cases.Hang.make({})],
          steps: [runCall("make one"), runCall("make two"), textStep("finished")],
          deadlineMs: 200,
        })
        const { events, results } = yield* session.run("Build.", true)
        expect(outcomes(results)).toEqual(["ok", "ok"])
        const [failed, late] = presentedTexts(events)
        expect(failed).toContain("the guard classifier failed")
        expect(late).toContain("the guard classifier did not answer in time")
        expect(session.ran).toEqual(["make one", "make two"])
        expect(session.calls).toHaveLength(2)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )

  it.scopedLive(
    "an unclear answer asks: a label that is not a verdict (the facet refuses it), or an unsure one",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.some({ policy: POLICY }),
          answers: [label("maybe"), label("allow", 0.2)],
          steps: [runCall("make one"), runCall("make two"), textStep("finished")],
        })
        const { events, results } = yield* session.run("Build.", false)
        expect(outcomes(results).map((outcome) => outcome.includes("was not approved"))).toEqual([
          true,
          true,
        ])
        const [odd, unsure] = presentedTexts(events)
        expect(odd).toContain("the guard classifier failed")
        expect(unsure).toContain("is not sure (allow, 0.20)")
        expect(session.ran).toEqual([])
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )

  it.scopedLive(
    "the classifier's prefix is the same bytes for every call; only the call differs",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.some({ policy: POLICY }),
          answers: [label("allow")],
          steps: [runCall("make one"), runCall("make two"), textStep("finished")],
        })
        yield* session.run("Build.", true)
        const [first, second] = session.calls
        if (Predicate.isUndefined(first) || Predicate.isUndefined(second))
          return yield* Effect.die("The classifier was not called twice")
        expect(first.decisions).toBe(second.decisions)
        expect(first.decisions).toContain(POLICY)
        expect(first.state).not.toBe(second.state)
        expect(first.state).toContain("make one")
        expect(second.state).toContain("make two")
        expect(first.state).not.toContain(POLICY)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )

  it.scopedLive(
    "a guard entry that does not decode asks about each call that is not read-only",
    () =>
      Effect.gen(function* () {
        const session = yield* guardedSession({
          guard: Option.some({ rules: [{ tool: "run", effect: "block" }] }),
          answers: [label("allow")],
          steps: [
            runCall("make"),
            toolCallStep("peek", { path: "README.md" }),
            textStep("finished"),
          ],
        })
        const { events, results } = yield* session.run("Build.", false)
        const [made, peeked] = outcomes(results)
        expect(made).toContain("the guard config does not decode")
        expect(peeked).toBe("ok")
        expect(presentedTexts(events)).toHaveLength(1)
        expect(session.calls).toEqual([])
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10_000,
  )
})

describe("guard call text", () => {
  it.effect("a rule's subject is a string input, or the one subject field of an object", () =>
    Effect.sync(() => {
      const subject = (input: Schema.Json) => callSubject({ input })
      expect(subject("echo hi")).toEqual(Option.some("echo hi"))
      expect(subject({ command: "ls", description: "list" })).toEqual(Option.some("ls"))
      expect(subject({ code: "await tools.run('ls')" })).toEqual(
        Option.some("await tools.run('ls')"),
      )
      // Two subject fields: a field the tool ignores never makes a rule match.
      expect(subject({ command: "rm -rf /", code: "git status" })).toEqual(Option.none())
      expect(subject({ count: 3 })).toEqual(Option.none())
    }),
  )

  it.effect("the classifier reads the tool and each field, a string raw and others as JSON", () =>
    Effect.sync(() => {
      expect(callText({ toolName: "cell", input: { code: "const a = 1\nawait run(a)" } })).toBe(
        "Tool: cell\n\ncode:\nconst a = 1\nawait run(a)",
      )
      expect(callText({ toolName: "run", input: { command: "ls", flags: ["-a"] } })).toBe(
        'Tool: run\n\ncommand:\nls\n\nflags: ["-a"]',
      )
      const long = callText({ toolName: "run", input: { command: "x".repeat(10_000) } })
      expect(long.length).toBeLessThanOrEqual(4_000)
      expect(long).toContain("characters truncated")
    }),
  )
})
