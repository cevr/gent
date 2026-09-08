import { makeClientActivityLayer } from "../src/extensions/client-activity"
import { Deferred, Effect, Layer, ManagedRuntime, Option } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import type { EventEnvelope } from "@gent/core-internal/domain/event"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import {
  makeClientComposerLayer,
  makeClientDriverLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "../src/extensions/client-services"
import {
  makeClientTransportLayer,
  type ClientShellTransportDefinition,
} from "../src/extensions/client-transport"
import type {
  AnyExtensionClientModule,
  BorderLabelPosition,
  ClientContributions,
  ClientRuntime,
} from "../src/extensions/client-facets.js"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"

export type ActiveClientSession = { readonly sessionId: SessionId; readonly branchId: BranchId }
// eslint-disable-next-line effect/noNullish -- Test harness ref mirrors the SDK's absent active-session state.
export type ActiveClientSessionRef = { value: ActiveClientSession | undefined }

export interface ClientExtensionHarnessOptions {
  readonly transport?: ClientShellTransportDefinition
  // eslint-disable-next-line effect/noNullish -- Test harness mirrors ClientTransport's optional callback.
  readonly currentSession?: () => ActiveClientSession | undefined
  readonly activeSession?: ActiveClientSessionRef
  readonly requestDeferred?: Deferred.Deferred<unknown, never>
  readonly requestEffect?: () => Effect.Effect<unknown, Error>
  readonly requestReply?: unknown
  readonly sessionEventSubscribers?: Set<(envelope: EventEnvelope) => void>
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
  ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      makeClientActivityLayer(() => ({ state: "idle" })),
      BunServices.layer,
      makeClientWorkspaceLayer({ cwd: "/tmp/test-cwd", home: "/tmp/test-home" }),
      makeClientShellLayer({
        sendMessage: () => {},
        openOverlay: () => {},
        closeOverlay: () => {},
        run: <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect),
        cast: <A, E>(effect: Effect.Effect<A, E, never>) => {
          Effect.runFork(effect)
        },
      }),
      makeClientDriverLayer({
        list: Effect.succeed({ drivers: [], overrides: {} }),
        set: () => Effect.void,
        clear: () => Effect.void,
      }),
      makeClientComposerLayer({
        state: () => ({
          draft: "",
          mode: "editing" satisfies "editing",
          inputFocused: false,
          autocompleteOpen: false,
        }),
      }),
      makeClientTransportLayer(opts.transport ?? makeClientTestTransport(opts)),
      makeClientLifecycleLayer({ addCleanup: () => {} }),
    ),
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

export const findBorderLabel = (
  contributions: ClientContributions,
  position: BorderLabelPosition,
) => contributions.borderLabels?.find((entry) => entry.position === position)

export const makeClientRuntime = (): ClientRuntime => makeClientExtensionRuntime()
