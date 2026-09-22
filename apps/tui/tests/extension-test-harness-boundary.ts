import { Deferred, Effect, Option } from "effect"
import type { BranchId, EventEnvelope, SessionId } from "@gent/core/protocol"
import type {
  AnyExtensionClientModule,
  BorderLabelPosition,
  ClientContributions,
  ClientRuntime,
  ClientShellDefinition,
  ClientShellTransportDefinition,
} from "../src/extensions/client-facets"
import { makeClientRuntime } from "../src/extensions/host"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"

export type ActiveClientSession = { readonly sessionId: SessionId; readonly branchId: BranchId }
// eslint-disable-next-line effect/noNullish -- Test harness ref mirrors the SDK's absent active-session state.
export type ActiveClientSessionRef = { value: ActiveClientSession | undefined }

export interface ClientExtensionHarnessOptions {
  readonly transport?: ClientShellTransportDefinition
  /** Shell callbacks a test wants to observe; the rest stay no-ops. */
  readonly shell?: Partial<ClientShellDefinition>
  // eslint-disable-next-line effect/noNullish -- Test harness mirrors ClientTransport's optional callback.
  readonly currentSession?: () => ActiveClientSession | undefined
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
  readonly workspace?: { readonly cwd: string; readonly home: string }
}

const waitForDeferred = <A, E>(deferred: Deferred.Deferred<A, E>) => Deferred.await(deferred)

export const makeActiveSessionRef = (value?: ActiveClientSession): ActiveClientSessionRef => ({
  value,
})

export const makeClientTestTransport = (
  opts: ClientExtensionHarnessOptions = {},
): ClientShellTransportDefinition => {
  const client = createMockClient({
    extension: {
      request: () => {
        const requestEffect = Option.fromNullishOr(opts.requestEffect)
        if (Option.isSome(requestEffect)) return requestEffect.value().pipe(Effect.orDie)
        const requestDeferred = Option.fromNullishOr(opts.requestDeferred)
        if (Option.isSome(requestDeferred)) return waitForDeferred(requestDeferred.value)
        return Effect.succeed(opts.requestReply)
      },
    },
  })
  const runtime = createMockRuntime()
  return {
    client,
    runtime,
    currentSession: opts.currentSession ?? (() => opts.activeSession?.value),
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

export const findBorderLabel = (
  contributions: ClientContributions,
  position: BorderLabelPosition,
) => contributions.borderLabels?.find((entry) => entry.position === position)
