import { Deferred, Effect, Option, type Scope } from "effect"
import { createSignal } from "solid-js"
import { BranchId, type EventEnvelope, type Model, SessionId } from "@gent/core/protocol"
import type {
  ClientActivitySnapshot,
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
import { createMockClient } from "./render-harness-boundary"

type ActiveClientSession = { readonly sessionId: SessionId; readonly branchId: BranchId }

/** The session in view when a test names none: the client always holds one. */
const TEST_SESSION: ActiveClientSession = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
}

interface ClientExtensionHarnessOptions {
  readonly transport?: ClientShellTransport
  /** Shell callbacks a test wants to observe; the rest stay no-ops. */
  readonly shell?: Partial<ClientShell>
  /** The session in view; `TEST_SESSION` when the test names none. */
  readonly currentSession?: () => ActiveClientSession
  readonly requestDeferred?: Deferred.Deferred<unknown, never>
  /** Answers every extension request; it sees the session the request names. */
  readonly requestEffect?: (request: ActiveClientSession) => Effect.Effect<unknown, Error>
  readonly requestReply?: unknown
  readonly sessionEventSubscribers?: Set<(envelope: EventEnvelope) => void>
  /** The model catalog the shell holds; settled empty by default. */
  readonly modelCatalog?: () => Option.Option<ReadonlyArray<Model>>
  /** The model the session in view runs next; `test/model` by default. */
  readonly selectedModel?: () => string
  /**
   * Workspace the extension sees. Defaults to a shared `/nonexistent` pair,
   * which is fine for a setup that only reads `cwd`; a test whose extension
   * writes under `home` must supply its own temp directory, or runs share one
   * file. The session's directory defaults to `cwd`.
   */
  readonly workspace?: TestWorkspace
  /**
   * Where the setup's cleanups go; by default nothing keeps them. A test
   * whose extension forks a watch or a timer runs them when its scope ends.
   */
  readonly lifecycle?: ClientContextDeps["lifecycle"]
}

type TestWorkspace = Omit<ClientContextDeps["workspace"], "sessionCwd"> &
  Partial<Pick<ClientContextDeps["workspace"], "sessionCwd">>

/**
 * Every `ClientContext` dependency, with the test defaults: a test transport
 * with no session, a `/nonexistent` workspace whose session directory is its
 * `cwd`, a shell whose `cast` forks and whose other callbacks do nothing, an
 * idle activity and a cleanup registry that keeps nothing. `deps` replaces any
 * default; `shell` is merged over the default shell.
 */
export const testClientContextDeps = (
  deps: Partial<Omit<ClientContextDeps, "shell" | "workspace">> & {
    readonly shell?: Partial<ClientShell>
    readonly workspace?: TestWorkspace
  } = {},
): ClientContextDeps => {
  const workspace = Option.getOrElse(Option.fromUndefinedOr(deps.workspace), () => ({
    cwd: "/nonexistent/test-cwd",
    home: "/nonexistent/test-home",
  }))
  return {
    transport: Option.getOrElse(Option.fromUndefinedOr(deps.transport), () =>
      makeClientTestTransport(),
    ),
    workspace: { sessionCwd: Effect.succeed(workspace.cwd), ...workspace },
    shell: {
      notify: () => {},
      switchSession: () => {},
      cast: <A, E>(effect: Effect.Effect<A, E, never>) => {
        Effect.runFork(effect)
      },
      pane: makePaneSlot(),
      ...deps.shell,
    },
    activity: Option.getOrElse(
      Option.fromUndefinedOr(deps.activity),
      () => (): ClientActivitySnapshot => ({ state: "idle" }),
    ),
    lifecycle: Option.getOrElse(Option.fromUndefinedOr(deps.lifecycle), () => ({
      addCleanup: () => {},
    })),
  }
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
          return requestEffect.value({ sessionId: request.sessionId, branchId: request.branchId })
        }
        const requestDeferred = Option.fromNullishOr(opts.requestDeferred)
        if (Option.isSome(requestDeferred)) return Deferred.await(requestDeferred.value)
        return Effect.succeed(opts.requestReply)
      },
    },
  })
  return {
    client,
    currentSession: Option.getOrElse(
      Option.fromUndefinedOr(opts.currentSession),
      () => () => TEST_SESSION,
    ),
    onExtensionStateChanged: () => () => {},
    onSessionEvent: (cb) => {
      opts.sessionEventSubscribers?.add(cb)
      return () => {
        opts.sessionEventSubscribers?.delete(cb)
      }
    },
    modelCatalog: opts.modelCatalog ?? (() => Option.some([])),
    selectedModel: opts.selectedModel ?? (() => "test/model"),
  }
}

/** Fail the test where it stands: a pure load test never reaches the transport. */
const throwOnAccess = (label: string): never =>
  Effect.runSync(Effect.die(`unexpected transport call in pure load test: ${label}`))

/** A transport whose every client call fails the test, for a load that must not reach it. */
export const makeUnreachableTransport = (): ClientShellTransport => ({
  client: new Proxy(createMockClient(), {
    get: (_target, prop) =>
      new Proxy(
        {},
        {
          get: (_target2, method) => () =>
            throwOnAccess(`client.${String(prop)}.${String(method)}`),
        },
      ),
  }),
  // The session in view is the shell's own state, not a transport call.
  currentSession: () => TEST_SESSION,
  onExtensionStateChanged: () => () => {},
  onSessionEvent: () => () => {},
  modelCatalog: () => Option.none(),
  selectedModel: () => "test/model",
})

export const makeClientExtensionRuntime = (
  opts: ClientExtensionHarnessOptions = {},
): ClientRuntime =>
  makeClientRuntime(
    BunServices.layer,
    testClientContextDeps({
      ...opts,
      transport: Option.getOrElse(Option.fromUndefinedOr(opts.transport), () =>
        makeClientTestTransport(opts),
      ),
    }),
  )

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
