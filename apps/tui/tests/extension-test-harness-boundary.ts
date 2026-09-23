import { Deferred, Effect, Option, type Scope } from "effect"
import { createSignal } from "solid-js"
import type { BranchId, EventEnvelope, SessionId } from "@gent/core/protocol"
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
import { makeClientRuntime } from "../src/extensions/host"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"

export type ActiveClientSession = { readonly sessionId: SessionId; readonly branchId: BranchId }
// eslint-disable-next-line effect/noNullish -- Test harness ref mirrors the SDK's absent active-session state.
export type ActiveClientSessionRef = { value: ActiveClientSession | undefined }

export interface ClientExtensionHarnessOptions {
  readonly transport?: ClientShellTransport
  /** Shell callbacks a test wants to observe; the rest stay no-ops. */
  readonly shell?: Partial<ClientShell>
  readonly currentSession?: () => Option.Option<ActiveClientSession>
  readonly activeSession?: ActiveClientSessionRef
  readonly requestDeferred?: Deferred.Deferred<unknown, never>
  readonly requestEffect?: () => Effect.Effect<unknown, Error>
  readonly requestReply?: unknown
  readonly sessionEventSubscribers?: Set<(envelope: EventEnvelope) => void>
  /**
   * Workspace the extension sees. Defaults to a shared `/tmp` pair, which is
   * fine for a setup that only reads `cwd`; a test whose extension writes
   * under `home` must supply its own temp directory, or runs share one file.
   */
  readonly workspace?: ClientContextDeps["workspace"]
}

export const makeActiveSessionRef = (value?: ActiveClientSession): ActiveClientSessionRef => ({
  value,
})

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
      request: () => {
        const requestEffect = Option.fromNullishOr(opts.requestEffect)
        if (Option.isSome(requestEffect)) return requestEffect.value().pipe(Effect.orDie)
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
  }
}

export const makeClientExtensionRuntime = (
  opts: ClientExtensionHarnessOptions = {},
): ClientRuntime =>
  makeClientRuntime({
    transport: Option.getOrElse(Option.fromUndefinedOr(opts.transport), () =>
      makeClientTestTransport(opts),
    ),
    workspace: Option.getOrElse(Option.fromUndefinedOr(opts.workspace), () => ({
      cwd: "/tmp/test-cwd",
      home: "/tmp/test-home",
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
