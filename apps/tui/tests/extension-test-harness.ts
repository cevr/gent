import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import type { GentNamespacedClient, GentRuntime } from "@gent/sdk"
import type { EventEnvelope } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import {
  makeClientComposerLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "../src/extensions/client-services"
import {
  makeClientTransportLayer,
  type ClientTransportShape,
} from "../src/extensions/client-transport"
import type {
  AnyExtensionClientModule,
  ClientContribution,
  ClientRuntime,
} from "../src/extensions/client-facets.js"

export type ActiveClientSession = { readonly sessionId: SessionId; readonly branchId: BranchId }
export type ActiveClientSessionRef = { value: ActiveClientSession | undefined }

export interface ClientExtensionHarnessOptions {
  readonly transport?: ClientTransportShape
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
): ClientTransportShape => {
  const client = {
    extension: {
      request: () => {
        if (opts.requestEffect !== undefined) return opts.requestEffect()
        if (opts.requestDeferred !== undefined) return waitForDeferred(opts.requestDeferred)
        return Effect.succeed(opts.requestReply)
      },
      listSlashCommands: () => Effect.succeed([]),
    },
  } as unknown as GentNamespacedClient
  const runtime = {
    cast: <A, E>(effect: Effect.Effect<A, E, never>): void => {
      Effect.runFork(effect)
    },
    fork: Effect.runFork,
    run: <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect),
  } as unknown as GentRuntime
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
      BunServices.layer,
      makeClientWorkspaceLayer({ cwd: "/tmp/test-cwd", home: "/tmp/test-home" }),
      makeClientShellLayer({
        sendMessage: () => {},
        openOverlay: () => {},
        closeOverlay: () => {},
      }),
      makeClientComposerLayer({
        state: () => ({
          draft: "",
          mode: "editing" as const,
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
): Effect.Effect<ReadonlyArray<ClientContribution>> =>
  Effect.promise(() =>
    runtime.runPromise(
      extension.setup as unknown as Effect.Effect<ReadonlyArray<ClientContribution>, never, never>,
    ),
  )

export const runClientExtensionSetupWithRuntime = (
  extension: AnyExtensionClientModule,
  opts: ClientExtensionHarnessOptions,
): Effect.Effect<ReadonlyArray<ClientContribution>> => {
  const runtime = makeClientExtensionRuntime(opts)
  return runClientExtensionSetup(runtime, extension).pipe(
    Effect.ensuring(Effect.promise(() => runtime.dispose())),
  )
}

export const findBorderLabel = (
  contributions: ReadonlyArray<ClientContribution>,
  position: Extract<ClientContribution, { _tag: "border-label" }>["position"],
): Extract<ClientContribution, { _tag: "border-label" }> | undefined =>
  contributions.find(
    (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
      entry._tag === "border-label" && entry.position === position,
  )

export const makeClientRuntime = (): ClientRuntime =>
  ManagedRuntime.make(
    Layer.merge(BunFileSystem.layer, BunServices.layer),
  ) as unknown as ClientRuntime
