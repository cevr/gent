import type { GentExtension } from "./extension"
import type {
  ClientContribution,
  ExtensionClientContext,
  ExtensionClientModule,
} from "./extension-client.js"
import type { AnyExtensionRequestMessage, ExtractExtensionReply } from "./extension-protocol.js"
import type { QueryRef } from "./query.js"

/**
 * Unified extension package — ties a server extension to a paired TUI client
 * module. The package is the user-visible "feature" that ships server +
 * client together.
 *
 * Client modules (*.client.ts) stay in apps/tui because they import Solid UI.
 * They consume server state via `client.extension.ask(...)` (typed RPC) and
 * subscribe to `ExtensionStateChanged` pulses for refetch signals — there is
 * no privileged out-of-band UI snapshot channel.
 *
 * If the package wants client widgets to read its server-side state without
 * each widget wiring its own poller, the package may declare a snapshot
 * source — either:
 *   - `snapshotRequest`: factory returning an actor protocol request
 *     (`ctx.extension.ask`-shaped); used when state lives in a workflow actor.
 *   - `snapshotQuery`: a `QueryRef` (`ctx.extension.query`-shaped); used when
 *     state is exposed via a typed `QueryContribution` (no actor required).
 *
 * The TUI provider wires a per-extension cache populated on every
 * `ExtensionStateChanged` pulse for this extension, exposing the decoded
 * value via the paired context's sync `getSnapshot()`.
 */
export interface ExtensionPackage<TSnapshot = unknown> {
  readonly id: string
  readonly server: GentExtension
  readonly snapshotRequest?: () => AnyExtensionRequestMessage
  readonly snapshotQuery?: QueryRef
  /** Create a paired TUI client module. ID is derived from this package. */
  readonly tui: <TComponent = unknown>(
    setup: (ctx: PairedTuiContext<TSnapshot>) => ReadonlyArray<ClientContribution<TComponent>>,
  ) => ExtensionClientModule<TComponent>
}

/** Extended context for paired TUI modules — adds a sync snapshot reader
 *  populated by a pulse-driven cache wired by the TUI provider. */
export interface PairedTuiContext<TSnapshot> extends ExtensionClientContext {
  readonly getSnapshot: () => TSnapshot | undefined
}

interface DefinePackageInputRequest<TRequest extends AnyExtensionRequestMessage> {
  readonly id: string
  readonly server: GentExtension
  readonly snapshotRequest: () => TRequest
}

interface DefinePackageInputQuery<I, O> {
  readonly id: string
  readonly server: GentExtension
  readonly snapshotQuery: QueryRef<I, O>
}

interface DefinePackageInputBare {
  readonly id: string
  readonly server: GentExtension
}

export function defineExtensionPackage(pkg: DefinePackageInputBare): ExtensionPackage<never>
export function defineExtensionPackage<TRequest extends AnyExtensionRequestMessage>(
  pkg: DefinePackageInputRequest<TRequest>,
): ExtensionPackage<ExtractExtensionReply<TRequest>>
export function defineExtensionPackage<I, O>(
  pkg: DefinePackageInputQuery<I, O>,
): ExtensionPackage<O>
export function defineExtensionPackage(
  pkg:
    | DefinePackageInputBare
    | DefinePackageInputRequest<AnyExtensionRequestMessage>
    | DefinePackageInputQuery<unknown, unknown>,
): ExtensionPackage<unknown> {
  if (pkg.id !== pkg.server.manifest.id) {
    throw new Error(
      `ExtensionPackage id "${pkg.id}" does not match server manifest id "${pkg.server.manifest.id}"`,
    )
  }
  const snapshotRequest = "snapshotRequest" in pkg ? pkg.snapshotRequest : undefined
  const snapshotQuery = "snapshotQuery" in pkg ? pkg.snapshotQuery : undefined

  const result: ExtensionPackage<unknown> = {
    id: pkg.id,
    server: pkg.server,
    snapshotRequest,
    snapshotQuery,
    tui: <TComponent = unknown>(
      setup: (ctx: PairedTuiContext<unknown>) => ReadonlyArray<ClientContribution<TComponent>>,
    ): ExtensionClientModule<TComponent> => {
      const snapshotSource = (() => {
        if (snapshotRequest !== undefined) {
          return { _tag: "request" as const, request: snapshotRequest }
        }
        if (snapshotQuery !== undefined) {
          return { _tag: "query" as const, query: snapshotQuery }
        }
        return undefined
      })()
      return {
        id: pkg.id,
        snapshotSource,
        setup: (baseCtx: ExtensionClientContext) => {
          // The TUI provider populates `baseCtx.getSnapshotRaw` per extension —
          // the paired typed wrapper just narrows the return type for this
          // package's snapshot shape.
          const pairedCtx: PairedTuiContext<unknown> = {
            ...baseCtx,
            getSnapshot: () => baseCtx.getSnapshotRaw(),
          }
          return setup(pairedCtx)
        },
      }
    },
  }
  return result
}

/**
 * Static factory for standalone TUI client modules (no server companion).
 * Use `package.tui(setup)` for paired modules instead.
 */
const standaloneClientModule = <TComponent = unknown>(
  id: string,
  setup: (ctx: ExtensionClientContext) => ReadonlyArray<ClientContribution<TComponent>>,
): ExtensionClientModule<TComponent> => ({ id, setup })

// Attach as static method on the ExtensionPackage namespace
export const ExtensionPackage = {
  tui: standaloneClientModule,
}

/** Input accepted by loaders — either a raw GentExtension or a unified package. */
export type ExtensionInput = GentExtension | ExtensionPackage

/** Type guard for ExtensionPackage (has `server` + `id`). */
export const isExtensionPackage = (value: ExtensionInput): value is ExtensionPackage =>
  "server" in value && "id" in value

/** Extract GentExtension from either shape. */
export const resolveExtensionInput = (input: ExtensionInput): GentExtension =>
  isExtensionPackage(input) ? input.server : input
