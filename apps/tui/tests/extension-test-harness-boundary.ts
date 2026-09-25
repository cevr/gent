import { Deferred, Effect, Option, type Scope } from "effect"
import { createSignal } from "solid-js"
import type { BranchId, EventEnvelope, Model, SessionId } from "@gent/core/protocol"
import type {
  ClientContextDeps,
  AnyExtensionClientModule,
  ClientContributions,
  ClientRuntime,
  ClientRuntimeServices,
  ClientShell,
  ClientShellTransport,
  PaneOwner,
} from "../src/extensions/client-facets"
import { BunServices } from "@effect/platform-bun"
import { makeClientRuntime } from "../src/extensions/host"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"

type ActiveClientSession = { readonly sessionId: SessionId; readonly branchId: BranchId }
// eslint-disable-next-line effect/noNullish -- Test harness ref mirrors the SDK's absent active-session state.
type ActiveClientSessionRef = { value: ActiveClientSession | undefined }

interface ClientExtensionHarnessOptions {
  readonly transport?: ClientShellTransport
  /** Shell callbacks a test wants to observe; the rest stay no-ops. */
  readonly shell?: Partial<ClientShell>
  readonly currentSession?: () => Option.Option<ActiveClientSession>
  readonly activeSession?: ActiveClientSessionRef
  readonly requestDeferred?: Deferred.Deferred<unknown, never>
  /** Answers every extension request; it sees the session the request names. */
  readonly requestEffect?: (request: ActiveClientSession) => Effect.Effect<unknown, Error>
  readonly requestReply?: unknown
  readonly sessionEventSubscribers?: Set<(envelope: EventEnvelope) => void>
  /** The model catalog the shell holds; settled empty by default. */
  readonly modelCatalog?: () => Option.Option<ReadonlyArray<Model>>
  /**
   * Workspace the extension sees. Defaults to a shared `/tmp` pair, which is
   * fine for a setup that only reads `cwd`; a test whose extension writes
   * under `home` must supply its own temp directory, or runs share one file.
   */
  readonly workspace?: ClientContextDeps["workspace"]
}

/** One pane slot, as the session overlay keeps it: opening a pane replaces the open one. */
export const makePaneSlot = (): PaneOwner => {
  const [open, setOpen] = createSignal(Option.none<string>())
  return {
    open: (id) => setOpen(Option.some(id)),
    close: (id) => {
      if (Option.contains(open(), id)) setOpen(Option.none())
    },
    isOpen: (id) => Option.contains(open(), id),
  }
}

export const makeClientTestTransport = (
  opts: ClientExtensionHarnessOptions = {},
): ClientShellTransport => {
  const client = createMockClient({
    extension: {
      request: (request: ActiveClientSession) => {
        const requestEffect = Option.fromNullishOr(opts.requestEffect)
        if (Option.isSome(requestEffect)) {
          return requestEffect
            .value({ sessionId: request.sessionId, branchId: request.branchId })
            .pipe(Effect.orDie)
        }
        const requestDeferred = Option.fromNullishOr(opts.requestDeferred)
        if (Option.isSome(requestDeferred)) return Deferred.await(requestDeferred.value)
        return Effect.succeed(opts.requestReply)
      },
    },
  })
  const runtime = createMockRuntime()
  return {
    client,
    runtime,
    currentSession: Option.getOrElse(
      Option.fromUndefinedOr(opts.currentSession),
      () => () => Option.fromNullishOr(opts.activeSession?.value),
    ),
    onExtensionStateChanged: () => () => {},
    onSessionEvent: (cb) => {
      opts.sessionEventSubscribers?.add(cb)
      return () => {
        opts.sessionEventSubscribers?.delete(cb)
      }
    },
    modelCatalog: opts.modelCatalog ?? (() => Option.some([])),
  }
}

export const makeClientExtensionRuntime = (
  opts: ClientExtensionHarnessOptions = {},
): ClientRuntime =>
  makeClientRuntime(BunServices.layer, {
    transport: Option.getOrElse(Option.fromUndefinedOr(opts.transport), () =>
      makeClientTestTransport(opts),
    ),
    workspace: Option.getOrElse(Option.fromUndefinedOr(opts.workspace), () => ({
      cwd: "/nonexistent/test-cwd",
      home: "/nonexistent/test-home",
    })),
    shell: {
      cast: <A, E>(effect: Effect.Effect<A, E, never>) => {
        Effect.runFork(effect)
      },
      pane: makePaneSlot(),
      ...Option.getOrElse(Option.fromUndefinedOr(opts.shell), () => ({})),
    },
    activity: () => ({ state: "idle" }),
  })

export const runClientExtensionSetup = (
  runtime: ClientRuntime,
  extension: AnyExtensionClientModule,
): Effect.Effect<ClientContributions> => Effect.promise(() => runtime.runPromise(extension.setup))

export const runClientExtensionSetupWithRuntime = (
  extension: AnyExtensionClientModule,
  opts: ClientExtensionHarnessOptions,
): Effect.Effect<ClientContributions> => {
  const runtime = makeClientExtensionRuntime(opts)
  return runClientExtensionSetup(runtime, extension).pipe(
    Effect.ensuring(Effect.promise(() => runtime.dispose())),
  )
}

/**
 * Build something that yields the client services, on a test runtime that the
 * surrounding scope disposes. The shell's `cast` forks as the host's does.
 */
export const provideClientServices = <A>(
  effect: Effect.Effect<A, never, ClientRuntimeServices>,
  opts: ClientExtensionHarnessOptions = {},
): Effect.Effect<A, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeClientExtensionRuntime(opts)),
    (runtime) => Effect.promise(() => runtime.dispose()),
  ).pipe(Effect.flatMap((runtime) => Effect.promise(() => runtime.runPromise(effect))))

/**
 * The Promise edge for a held library call, such as fff's `waitForScan`.
 * `hold(call)` returns a Promise that says `started`, waits for `release`,
 * then runs `call`, so a test can act while a caller awaits it. It runs with
 * the caller's own services instead of starting a runtime beside them.
 */
interface PromiseHold {
  /** Completes once a held call is waiting. */
  readonly started: Effect.Effect<void>
  /** Lets the held call run. */
  readonly release: Effect.Effect<void>
  readonly hold: <A>(call: () => Promise<A>) => Promise<A>
}

export const makePromiseHold: Effect.Effect<PromiseHold> = Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const gate = yield* Deferred.make<void>()
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
  return {
    started: Deferred.await(started),
    release: Deferred.succeed(gate, void 0).pipe(Effect.asVoid),
    hold: (call) =>
      runPromise(
        Deferred.succeed(started, void 0).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(Effect.promise(call)),
        ),
      ),
  }
})
