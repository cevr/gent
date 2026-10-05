import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  type Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Record,
  Ref,
  Scheduler,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { LanguageModel } from "effect/ai"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter creates worker files before the child runtime starts.
import * as fs from "node:fs"
import * as os from "node:os"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter builds worker paths before the child runtime starts.
import * as path from "node:path"
import type { ProviderOptions } from "effect/ai/LanguageModel"
import type * as AiError from "effect/ai/AiError"
import * as Prompt from "effect/ai/Prompt"
import {
  type ApiClassContribution,
  type CredentialSlot,
  type StoredOAuthCredentials,
  type ModelDriverContribution,
  ProviderStopReason,
  reportProviderStopReason,
} from "../domain/driver.js"
import { ExtensionRegistry, resolveExtensions } from "../runtime/extension-host.js"
import { omitUndefined } from "../domain/guards.js"
import { ExtensionId } from "../domain/ids.js"
import { ProviderError } from "../domain/errors.js"
import {
  aiError,
  Auth,
  AuthApi,
  AuthInfo,
  type LoadedModelCatalog,
  ModelCatalogSource,
  ModelResolver,
  driverCarriesEffort,
  type ResolveModelRequest,
  finishPart,
  type LanguageModelStreamPart,
  makeLanguageModelLayer,
  ScriptedLanguageModel,
  type ScriptedStep,
  signInReady,
  textDeltaPart,
} from "../runtime/provider.js"

// ── stored-credential model ─────────────────────────────────────────────────

/**
 * The language model a turn resolves for `modelId` through the production
 * resolver, from `modelDrivers` and an auth store holding the API keys in
 * `stored` (store key → key), plus optional slot-bound OAuth rows. It resolves
 * `credentialSlot` when supplied, else the legacy default. A driver test sends a request over
 * a fake fetch to see which credential a sign-in sends; a failed resolution
 * is a defect. The resolver reads `catalog` (usually `fixtureModelCatalog()`)
 * and composes a driver's endpoint with `apiClasses`.
 */
export const storedCredentialModel = (input: {
  readonly modelDrivers: ReadonlyArray<ModelDriverContribution>
  readonly apiClasses?: ReadonlyArray<ApiClassContribution>
  readonly stored: Readonly<Record<string, string>>
  readonly oauth?: ReadonlyArray<{
    readonly provider: string
    readonly slot?: CredentialSlot
    readonly credential: StoredOAuthCredentials
  }>
  readonly credentialSlot?: CredentialSlot
  readonly modelId: string
  readonly catalog: LoadedModelCatalog
}): Layer.Layer<LanguageModel.LanguageModel> => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("@gent/test/stored-credential") },
      scope: "builtin",
      sourcePath: "test",
      contributions: { modelDrivers: input.modelDrivers, apiClasses: input.apiClasses ?? [] },
    },
  ])
  const seed = Record.map(input.stored, (key) => AuthApi.make({ type: "api", key }))
  return Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const auth = yield* Auth
      for (const entry of input.oauth ?? []) {
        yield* auth.set(
          entry.provider,
          AuthInfo.cases.Oauth.make({ type: "oauth", ...entry.credential }),
          entry.slot,
        )
      }
      const resolver = yield* ModelResolver
      return yield* resolver.resolve({
        modelId: input.modelId,
        ...omitUndefined({ credentialSlot: input.credentialSlot }),
      })
    }).pipe(
      Effect.provideService(
        ExtensionRegistry,
        ExtensionRegistry.of({ getResolved: () => resolved, providerConfig: Effect.succeed({}) }),
      ),
      Effect.orDie,
    ),
  ).pipe(
    Layer.provide(ModelResolver.Live),
    Layer.provide(Auth.Test(seed)),
    Layer.provide(ModelCatalogSource.fixed(input.catalog)),
  )
}

/**
 * Run `effect` as a loop step does, listening for the raw stop reason a
 * driver reports (`ProviderStopReason`); returns the last one reported.
 */
export const captureProviderStopReason = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<string>, E, Exclude<R, ProviderStopReason>> =>
  Effect.gen(function* () {
    const reported = yield* Ref.make(Option.none<string>())
    yield* effect.pipe(
      Effect.provideService(
        ProviderStopReason,
        ProviderStopReason.of({ report: (reason) => Ref.set(reported, Option.some(reason)) }),
      ),
    )
    return yield* Ref.get(reported)
  })

// ── fixtures ────────────────────────────────────────────────────────────────

/** Create a temp directory that is removed when the test scope closes. */
export const makeTempDirectoryScoped = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), prefix))),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  )

/**
 * A port the kernel just handed out and took back: a listener binds port 0,
 * the kernel picks a free port, and the listener closes before the server
 * under test binds it. A random pick from a range can land on a port another
 * lane's server holds.
 */
export const freePort: Effect.Effect<number> = Effect.gen(function* () {
  const { address } = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 })
  if (address._tag === "UnixPathAddress") return yield* Effect.die("a TCP listener has no path")
  return address.port
}).pipe(Effect.scoped, Effect.orDie)

/** Create a worker environment with its own data and auth directories under `root`. */
export const createWorkerEnv = (root: string): Record<string, string> => {
  const dataDir = path.join(root, "data")
  fs.mkdirSync(dataDir, { recursive: true })

  const env = Record.empty<string, string>()
  env["GENT_DATA_DIR"] = dataDir
  env["GENT_AUTH_DIRECTORY"] = path.join(root, "auth")
  return env
}

/**
 * Store a test API key for anthropic and openai in `directory`, the auth
 * store a spawned gent reads through `GENT_AUTH_DIRECTORY` (see
 * `createWorkerEnv`), so the child starts without asking for a key.
 */
export const seedAuthKeys = (directory: string) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(Auth.Live(directory).pipe(Layer.provide(BunServices.layer)))
    const auth = Context.get(services, Auth)
    yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "test-key" }))
    yield* auth.set("openai", AuthApi.make({ type: "api", key: "test-key" }))
  }).pipe(Effect.scoped)

class WaitForError extends Schema.TaggedError<WaitForError>()(
  "@gent/core/src/test-utils/language-model/WaitForError",
  { message: Schema.String },
) {}

// oxlint-disable-next-line effect/noUnknownParameters -- Cause.squash exposes an unknown defect at this test failure boundary.
const toWaitForError = (error: unknown) => {
  if (error instanceof Error) return new WaitForError({ message: error.message })
  return new WaitForError({ message: String(error) })
}

/** Poll an effect until predicate passes or timeout */
export const waitFor = <A, R = never>(
  effect: Effect.Effect<A, unknown, R>,
  predicate: (value: A) => boolean,
  timeoutMs = 5_000,
  label = "condition",
): Effect.Effect<A, WaitForError, R> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<A, WaitForError, R> = Effect.gen(function* () {
      const attempt = yield* effect.pipe(Effect.exit)
      if (attempt._tag === "Success" && predicate(attempt.value)) {
        return attempt.value
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        let errorMessage = `timed out waiting for ${label}`
        if (attempt._tag === "Failure") {
          errorMessage += `: ${toWaitForError(Cause.squash(attempt.cause)).message}`
        }
        return yield* new WaitForError({ message: errorMessage })
      }
      // oxlint-disable-next-line effect/noFixedWaitInTests -- the poll interval of waitFor, the helper the rule points tests to
      yield* Effect.sleep("5 millis")
      return yield* loop
    })
    return yield* loop
  })

/** One run of `interruptAtEachStep`: what it interrupts and what must hold after. */
export interface InterruptionTrial<A, E, R, E2, R2> {
  readonly program: Effect.Effect<A, E, R>
  /** The steps that count: the boundaries where this holds. Every boundary counts by default. */
  readonly at?: () => boolean
  /** Checked after the run, interrupted or not. */
  readonly invariant: (exit: Exit.Exit<A, E>, interrupted: boolean) => Effect.Effect<void, E2, R2>
}

/**
 * Interrupt a program at each step in turn and check what must hold after:
 * run k sets up a fresh trial, interrupts its program at the k-th scheduler
 * boundary where `at` holds (the runtime asks the scheduler whether to yield
 * before each operation), and runs the invariant. The walk ends with the first
 * run the program completes before its interruption point, so a test does not
 * depend on how many steps the implementation takes. Each run is its own
 * scope. A program still running after `limit` interruption points is a
 * defect. Returns the number of runs.
 */
export const interruptAtEachStep = <A, E, R, E2, R2, ES, RS>(
  trial: Effect.Effect<InterruptionTrial<A, E, R, E2, R2>, ES, RS>,
  limit = 64,
): Effect.Effect<number, E2 | ES, Exclude<R | R2 | RS, Scope.Scope>> =>
  Effect.gen(function* () {
    for (let step = 1; step <= limit; step++) {
      const completed = yield* Effect.scoped(
        Effect.gen(function* () {
          const { program, at = () => true, invariant } = yield* trial
          const scheduler = new Scheduler.MixedScheduler()
          let root = Option.none<Fiber.Fiber<unknown, unknown>>()
          let seen = 0
          let interrupted = false
          const interrupting: Scheduler.Scheduler = {
            executionMode: scheduler.executionMode,
            makeDispatcher: () => scheduler.makeDispatcher(),
            shouldYield: (fiber) => {
              // The program's own fiber: a fiber it forks (a timer, a worker)
              // inherits the scheduler, and stopping one alone is not an
              // interruption of the program.
              const own = Option.isSome(root) && root.value === fiber
              if (!interrupted && own && at() && ++seen === step) {
                interrupted = true
                // The runtime exposes this hook to synchronous schedulers.
                fiber.interruptUnsafe()
              }
              return scheduler.shouldYield(fiber)
            },
          }
          const run = yield* Effect.withFiber((fiber) => {
            root = Option.some(fiber)
            return program
          }).pipe(Effect.provideService(Scheduler.Scheduler, interrupting), Effect.forkChild)
          yield* invariant(yield* Fiber.await(run), interrupted)
          return !interrupted
        }),
      )
      if (completed) return step
    }
    return yield* Effect.die(
      new Error(`the program was still running after ${limit} interruption points`),
    )
  })

// ── request shape ───────────────────────────────────────────────────────────

/**
 * A step's request as the runtime builds it: the system prompt it opens
 * with (its cache blocks, and the blocks joined as the one prompt text), and
 * the turn notices it places after the conversation (empty when the step
 * carries none).
 */
export const turnRequestText = (prompt: Prompt.Prompt) => {
  const systemAt = (index: number) =>
    Option.fromUndefinedOr(prompt.content[index]).pipe(
      Option.flatMap((message) => {
        if (message.role !== "system") return Option.none()
        return Option.some(message.content)
      }),
    )
  let leading = prompt.content.findIndex((message) => message.role !== "system")
  if (leading < 0) leading = prompt.content.length
  const systemBlocks = prompt.content.slice(0, leading).flatMap((message) => {
    if (message.role !== "system") return []
    return [message.content]
  })
  const lastIndex = prompt.content.length - 1
  const notices = Option.filter(systemAt(lastIndex), () => lastIndex >= systemBlocks.length)
  return {
    systemBlocks,
    systemPrompt: systemBlocks.join("\n\n"),
    notices: Option.getOrElse(notices, () => ""),
  }
}

/** The system prompt a step opened with, from the prompt or its raw input. */
export const systemTextOf = (prompt: Prompt.RawInput): string =>
  turnRequestText(Prompt.make(prompt)).systemPrompt

// ── language-model ──────────────────────────────────────────────────────────

interface SignalLanguageModelControls {
  readonly emitNext: Effect.Effect<void>
  readonly emitAll: Effect.Effect<void>
  readonly waitForStreamStart: Effect.Effect<void>
}

/** A scripted step (`textStep`, `toolCallStep`, …), with the sequence's checks and gate. */
export interface SequenceStep extends ScriptedStep {
  readonly assertRequest?: (request: {
    readonly model: string
    readonly reasoning?: string
    /** The output cap the request asks the driver for. */
    readonly maxTokens?: number
    /** The effort each earlier assistant run was sent at (`ProviderHints.reasoningHistory`). */
    readonly reasoningHistory: ReadonlyArray<Option.Option<string>>
  }) => void
  readonly assertOptions?: (options: ProviderOptions) => void
  readonly gated?: boolean
  /**
   * The provider's raw stop reason, which the step reports through
   * `ProviderStopReason` as a driver that reads the wire does. The finish
   * part still carries Effect AI's mapped reason (`"unknown"` for a reason
   * its map lacks).
   */
  readonly stopReason?: string
}

interface SequenceLanguageModelControls {
  readonly waitForCall: (index: number) => Effect.Effect<void>
  readonly emitAll: (index: number) => Effect.Effect<void>
  readonly callCount: Effect.Effect<number>
  /**
   * Dies when a scripted step was not consumed, or when an `assertOptions` or
   * `assertRequest` check failed. A failed check also fails its call, which a
   * turn reads as a provider error and goes past, so only this read makes the
   * test fail on it.
   */
  readonly assertDone: Effect.Effect<void>
}

const testStream = (
  stream: (
    options: ProviderOptions,
  ) => Effect.Effect<Stream.Stream<LanguageModelStreamPart, AiError.AiError>, AiError.AiError>,
): Layer.Layer<LanguageModel.LanguageModel> =>
  makeLanguageModelLayer({
    streamText: (options) => stream(options).pipe(Stream.unwrap),
    generateText: () => Effect.succeed("test response"),
  })

/** One layer value, so every test that provides it shares its memoized build. */
const failingLayer = makeLanguageModelLayer({
  streamText: () => Stream.fail(aiError("Failing.streamText", "provider exploded")),
  generateText: () => Effect.fail(aiError("Failing.generateText", "provider exploded")),
})

const signal = (reply: string, options?: { inputTokens?: number; outputTokens?: number }) =>
  Effect.gen(function* () {
    const gate = yield* Queue.unbounded<"continue">()
    const streamStarted = yield* Deferred.make<void>()

    const parts = reply
      .split(/(?<=[.!?])\s+/)
      .filter((chunk) => chunk.length > 0)
      .map((text) => textDeltaPart(`${text} `))

    const allParts = [
      ...parts,
      finishPart({
        finishReason: "stop",
        usage: {
          inputTokens: options?.inputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
          outputTokens: options?.outputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
        },
      }),
    ]

    const layer = makeLanguageModelLayer({
      streamText: () =>
        Stream.fromEffect(Deferred.succeed(streamStarted, void 0)).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable(allParts).pipe(
              Stream.mapEffect((part) => Queue.take(gate).pipe(Effect.as(part))),
            ),
          ),
        ),
      generateText: () => Effect.succeed(reply),
    })

    const controls: SignalLanguageModelControls = {
      emitNext: Queue.offer(gate, "continue").pipe(Effect.asVoid),
      emitAll: Effect.forEach(allParts, () => Queue.offer(gate, "continue").pipe(Effect.asVoid)),
      waitForStreamStart: Deferred.await(streamStarted),
    }

    return { layer, controls }
  })

/**
 * The resolve-request check a sequence's `assertRequest` steps install. Only
 * `LanguageModelLayers.resolver` reads it; a model layer without one resolves
 * unchecked.
 */
const SequenceRequestAssertion = Context.Reference<
  Option.Option<(request: ResolveModelRequest) => Effect.Effect<void, ProviderError>>
>("@gent/core/src/test-utils/language-model/SequenceRequestAssertion", {
  defaultValue: () => Option.none(),
})

const sequence = (steps: ReadonlyArray<SequenceStep>) =>
  Effect.gen(function* () {
    const indexRef = yield* Ref.make(0)
    const requestIndexRef = yield* Ref.make(0)
    const checkFailures = yield* Ref.make<ReadonlyArray<string>>([])
    const recordCheckFailure = (message: string) =>
      Ref.update(checkFailures, (failures) => [...failures, message])
    const callStarted = yield* Effect.forEach(steps, () => Deferred.make<void>())
    const emitGates = yield* Effect.forEach(steps, () => Deferred.make<void>())

    yield* Effect.forEach(steps, (step, i) => {
      const gate = emitGates[i]
      if (step.gated || Predicate.isUndefined(gate)) return Effect.void
      return Deferred.succeed(gate, void 0)
    })

    const languageModelLayer = makeLanguageModelLayer({
      streamText: (options) =>
        Effect.gen(function* () {
          const idx = yield* Ref.getAndUpdate(indexRef, (n) => n + 1)

          const step = steps[idx]
          if (Predicate.isUndefined(step)) {
            return yield* aiError(
              "Sequence.streamText",
              `Sequence language model: streamText() called ${idx + 1} times but only ${steps.length} steps scripted`,
            )
          }
          const started = callStarted[idx]
          const gate = emitGates[idx]

          // The check runs, and a failure is recorded, before `waitForCall`
          // resolves, so an `assertDone` after `waitForCall` sees it.
          const assertOptions = step.assertOptions
          const checked = yield* Effect.exit(
            Effect.try({
              try: () => assertOptions?.(options),
              catch: (e) => `Sequence language model: assertOptions failed at step ${idx}: ${e}`,
            }).pipe(Effect.tapError(recordCheckFailure)),
          )
          if (!Predicate.isUndefined(started)) yield* Deferred.succeed(started, void 0)
          yield* checked.pipe(Effect.mapError((message) => aiError("Sequence.streamText", message)))

          if (Predicate.isNotUndefined(step.stopReason)) {
            yield* reportProviderStopReason(step.stopReason)
          }

          if (!Predicate.isUndefined(gate)) {
            return Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() => Stream.fromIterable(step.parts)),
            )
          }
          return Stream.fromIterable(step.parts)
        }).pipe(Stream.unwrap),
      generateText: () => Effect.succeed("sequence language model"),
    })
    const requestAssertionLayer = Layer.succeed(
      SequenceRequestAssertion,
      Option.some((request: ResolveModelRequest) =>
        Effect.gen(function* () {
          const idx = yield* Ref.getAndUpdate(requestIndexRef, (n) => n + 1)
          const step = steps[idx]
          if (Predicate.isUndefined(step?.assertRequest)) return
          yield* Effect.try({
            try: () =>
              step.assertRequest?.({
                model: String(request.modelId),
                reasoningHistory: request.hints?.reasoningHistory ?? [],
                ...omitUndefined({
                  reasoning: request.hints?.reasoning,
                  maxTokens: request.hints?.maxTokens,
                }),
              }),
            catch: (e) =>
              new ProviderError({
                message: `Sequence language model: assertRequest failed at step ${idx}: ${e}`,
                model: request.modelId,
                cause: e,
              }),
          }).pipe(Effect.tapError((error) => recordCheckFailure(error.message)))
        }),
      ),
    )
    const layer = Layer.merge(languageModelLayer, requestAssertionLayer)

    const controls: SequenceLanguageModelControls = {
      waitForCall: (index) => {
        const deferred = callStarted[index]
        if (index < 0 || index >= steps.length || Predicate.isUndefined(deferred)) {
          return Effect.die(
            new Error(`waitForCall: index ${index} out of range [0, ${steps.length})`),
          )
        }
        return Deferred.await(deferred)
      },
      emitAll: (index) => {
        const deferred = emitGates[index]
        if (index < 0 || index >= steps.length || Predicate.isUndefined(deferred)) {
          return Effect.die(new Error(`emitAll: index ${index} out of range [0, ${steps.length})`))
        }
        return Deferred.succeed(deferred, void 0)
      },
      callCount: Ref.get(indexRef),
      assertDone: Effect.gen(function* () {
        const failures = yield* Ref.get(checkFailures)
        if (failures.length > 0) {
          return yield* Effect.die(new Error(failures.join("\n")))
        }
        const consumed = yield* Ref.get(indexRef)
        if (consumed >= steps.length) return
        return yield* Effect.die(
          new Error(
            `Sequence language model: ${steps.length - consumed} unconsumed steps (consumed ${consumed}/${steps.length})`,
          ),
        )
      }),
    }

    return { layer, controls }
  })

/**
 * A model resolver over a test model layer: it serves the one model for every
 * request, after the sequence's `assertRequest` check when the layer has one.
 * Every driver counts as signed in. The registered drivers say what their
 * wire carries (`carriesEffort`), over the catalog when the root serves one.
 */
const resolver = (layer: Layer.Layer<LanguageModel.LanguageModel>): Layer.Layer<ModelResolver> =>
  Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const assertRequest = yield* SequenceRequestAssertion
      const catalogSource = yield* Effect.serviceOption(ModelCatalogSource)
      return ModelResolver.of({
        resolve: (request) =>
          Option.match(assertRequest, {
            onNone: () => Effect.succeed(model),
            onSome: (check) => check(request).pipe(Effect.as(model)),
          }),
        signedIn: () => Effect.succeed(true),
        carriesEffort: (request, registry) => driverCarriesEffort(request, registry, catalogSource),
      })
    }),
  ).pipe(Layer.provide(layer))

/**
 * `resolver`'s model, with each driver signed in as the production resolver
 * reads it (`signInReady`): a test about which drivers a turn can run on.
 */
const signInCheckedResolver = (
  layer: Layer.Layer<LanguageModel.LanguageModel>,
): Layer.Layer<ModelResolver, never, Auth | ModelCatalogSource> =>
  Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const scripted = yield* ModelResolver
      const auth = yield* Auth
      const catalogSource = yield* ModelCatalogSource
      return ModelResolver.of({
        resolve: scripted.resolve,
        carriesEffort: scripted.carriesEffort,
        signedIn: (driverId, registry) =>
          signInReady(driverId).pipe(
            Effect.provideService(Auth, auth),
            Effect.provideService(ModelCatalogSource, catalogSource),
            Effect.provideService(ExtensionRegistry, registry),
          ),
      })
    }),
  ).pipe(Layer.provide(resolver(layer)))

export const LanguageModelLayers = {
  resolver,
  signInCheckedResolver,
  testStream,
  /**
   * The scripted model without its rate-limit retries unless a test asks for
   * them (`retries: true`): a retry pays the real backoff.
   */
  debug: (options?: Parameters<typeof ScriptedLanguageModel.debug>[0]) =>
    ScriptedLanguageModel.debug({ retries: false, ...options }),
  get empty() {
    return ScriptedLanguageModel.empty
  },
  get failing() {
    return failingLayer
  },
  sequence,
  signal,
}
