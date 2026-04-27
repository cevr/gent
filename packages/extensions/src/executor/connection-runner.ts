/**
 * ExecutorConnectionRunner — long-lived observer that drives the
 * sidecar connection in response to actor state transitions.
 *
 * The actor (`executorBehavior`) is sync-only and stores no side
 * effects. Whenever the actor enters `Connecting`, this runner forks
 * an effect that resolves the sidecar endpoint + MCP inspection and
 * sends `Connected{...}` back. On failure it sends `ConnectionFailed`.
 *
 * Implemented as a `Layer.effect` whose effect runs in the host's
 * scope, so the long-lived fork is auto-cancelled at scope close.
 *
 * Bootstrap: the actor is spawned by `ActorHost` from a sibling layer.
 * The runner subscribes to the executor's `ServiceKey` registration
 * stream and waits for the first non-empty ref set before driving
 * state. After that, it reads the user's autoStart setting and tells
 * `Connect{cwd}` once when state is `Idle`.
 *
 * Observation channel: `ActorEngine.subscribeState(ref)` returns a
 * `Stream<unknown>` (state-type erased at the engine boundary). This
 * runner narrows by the state's `_tag` field — the same invariant
 * documented on `ActorContext.subscribeState`.
 */

import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ActorEngine, Receptionist, type ActorRef } from "@gent/core/extensions/api"
import { ExecutorEndpoint, ExecutorMcpInspection, type ResolvedExecutorSettings } from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import { ExecutorMsg, ExecutorService } from "./actor.js"

/**
 * Tag for the runner's lifetime handle. The Resource shell uses it as
 * the canonical service tag; the implementation has no public methods
 * — its purpose is purely to anchor the layer's lifetime.
 */
export class ExecutorConnectionRunner extends Context.Service<
  ExecutorConnectionRunner,
  Record<string, never>
>()("@gent/executor/ConnectionRunner") {}

const isConnecting = (
  state: unknown,
): state is { readonly _tag: "Connecting"; readonly cwd: string } =>
  typeof state === "object" &&
  state !== null &&
  "_tag" in state &&
  (state as { _tag: unknown })._tag === "Connecting"

const isIdle = (state: unknown): state is { readonly _tag: "Idle" } =>
  typeof state === "object" &&
  state !== null &&
  "_tag" in state &&
  (state as { _tag: unknown })._tag === "Idle"

const tellFailure = (
  ref: ActorRef<ExecutorMsg>,
  message: string,
): Effect.Effect<void, never, ActorEngine> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    yield* engine
      .tell(ref, ExecutorMsg.ConnectionFailed.make({ message }))
      .pipe(Effect.catchEager(() => Effect.void))
  })

/** Run the sidecar connection workflow once and tell the actor the result. */
const runConnection = (
  cwd: string,
  ref: ActorRef<ExecutorMsg>,
): Effect.Effect<void, never, ActorEngine | ExecutorSidecar | ExecutorMcpBridge> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    const sidecar = yield* ExecutorSidecar
    const bridge = yield* ExecutorMcpBridge

    const endpointRaw = yield* sidecar.resolveEndpoint(cwd)
    const endpoint = yield* Schema.decodeUnknownEffect(ExecutorEndpoint)(endpointRaw)

    const inspection = yield* bridge.inspect(endpoint.baseUrl).pipe(
      Effect.flatMap((raw) => Schema.decodeUnknownEffect(ExecutorMcpInspection)(raw)),
      Effect.orElseSucceed(() => undefined),
    )

    yield* engine.tell(
      ref,
      ExecutorMsg.Connected.make({
        mode: endpoint.mode,
        baseUrl: endpoint.baseUrl,
        scopeId: endpoint.scope.id,
        executorPrompt: inspection?.instructions,
      }),
    )
  }).pipe(
    Effect.catchEager((e) => tellFailure(ref, e instanceof Error ? e.message : String(e))),
    Effect.catchDefect((e) => tellFailure(ref, e instanceof Error ? e.message : String(e))),
  )

/** Wait until at least one executor actor is registered, then return the ref. */
const awaitExecutorRef: Effect.Effect<ActorRef<ExecutorMsg>, never, Receptionist> = Effect.gen(
  function* () {
    const reg = yield* Receptionist
    const stream = reg.subscribe(ExecutorService).pipe(
      Stream.filter((refs) => refs.length > 0),
      Stream.take(1),
    )
    const refs = yield* Stream.runCollect(stream)
    const arr = Array.from(refs)[0]
    if (arr === undefined || arr[0] === undefined) {
      return yield* Effect.die("ExecutorConnectionRunner: no executor actor registered")
    }
    return arr[0]
  },
)

const supervise = (
  ref: ActorRef<ExecutorMsg>,
): Effect.Effect<void, never, ActorEngine | ExecutorSidecar | ExecutorMcpBridge> =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    yield* engine.subscribeState(ref).pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          if (!isConnecting(state)) return
          // Fork the connection — runs inside the supervise fiber, so it
          // inherits the layer scope without naming `Scope` in R.
          // Successive Connecting entries each spawn a fresh fork; late
          // `Connected/Failed` tells from in-flight forks become no-ops
          // in the wrong state (`receive` ignores them).
          yield* Effect.asVoid(Effect.forkChild(runConnection(state.cwd, ref)))
        }),
      ),
    )
  })

const autoStartIfNeeded = (
  ref: ActorRef<ExecutorMsg>,
  cwd: string,
): Effect.Effect<void, never, ActorEngine | ExecutorSidecar> =>
  Effect.gen(function* () {
    const sidecar = yield* ExecutorSidecar
    const settingsRaw = yield* sidecar
      .resolveSettings(cwd)
      .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
    if (settingsRaw === undefined) return
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- settings is the resolved settings shape from the sidecar surface
    const settings = settingsRaw as ResolvedExecutorSettings
    if (!settings.autoStart) return
    const engine = yield* ActorEngine
    // Read the head of the state stream — it's the current value via
    // SubscriptionRef's replay buffer. `transitionConnect` already
    // gates this, but skipping the redundant tell when the actor is
    // already past Idle keeps the message log noise-free.
    const head = yield* Stream.runCollect(engine.subscribeState(ref).pipe(Stream.take(1)))
    const first = Array.from(head)[0]
    if (first === undefined) return
    if (!isIdle(first)) return
    yield* engine.tell(ref, ExecutorMsg.Connect.make({ cwd }))
  })

/**
 * Layer that boots the runner. Order:
 *   1. Wait for the executor actor to register on its `ServiceKey`.
 *   2. Fork the long-lived state observer.
 *   3. Run the autoStart bootstrap once on the resolved cwd.
 *
 * The whole bootstrap chain runs inside a `forkScoped` so the layer
 * effect itself returns promptly — host startup must not block on a
 * sidecar resolve.
 */
export const ExecutorConnectionRunnerLayer = (
  cwd: string,
): Layer.Layer<
  ExecutorConnectionRunner,
  never,
  ActorEngine | Receptionist | ExecutorSidecar | ExecutorMcpBridge
> =>
  Layer.effect(
    ExecutorConnectionRunner,
    Effect.gen(function* () {
      const layerScope = yield* Effect.scope
      // Fork the bootstrap chain into the layer scope. Inside the
      // bootstrap, fork `supervise` AGAIN into the layer scope so the
      // observer outlives the short-lived autoStart bootstrap (which
      // returns immediately when `autoStart=false`). Both forks are
      // siblings under the layer scope.
      const bootstrap = Effect.gen(function* () {
        const ref = yield* awaitExecutorRef
        yield* supervise(ref).pipe(Effect.forkIn(layerScope))
        yield* autoStartIfNeeded(ref, cwd)
      }).pipe(Effect.catchDefect(() => Effect.void))
      yield* bootstrap.pipe(Effect.forkIn(layerScope))
      return ExecutorConnectionRunner.of({})
    }),
  )
