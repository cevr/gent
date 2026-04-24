/**
 * Builtin-only extension internals.
 *
 * This seam exists for Gent-owned extensions that need runtime or app services
 * which are intentionally excluded from the public authoring API.
 */

import type { SlotsDef } from "effect-machine"
import type {
  ExtensionEffect,
  MessageMetadata,
  ResourceContribution,
  ResourceMachine,
  ResourceScope,
  ResourceSpec,
} from "./api.js"

export type { ExtensionStorage } from "../runtime/extensions/extension-storage.js"
export { EventPublisher } from "../domain/event-publisher.js"
export { ToolRunner, type ToolRunnerService } from "../runtime/agent/tool-runner.js"
export { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
export { MachineExecute } from "../runtime/extensions/machine-execute.js"
export {
  InteractionPendingReader,
  type InteractionPendingReaderService,
  type PendingInteraction,
} from "../storage/interaction-pending-reader.js"

export type BuiltinRuntimeEffect =
  | {
      readonly _tag: "QueueFollowUp"
      readonly content: string
      readonly metadata?: MessageMetadata
    }
  | { readonly _tag: "Interject"; readonly content: string }
  | ExtensionEffect

export interface BuiltinResourceMachine<
  State extends { readonly _tag: string } = { readonly _tag: string },
  Event extends { readonly _tag: string } = { readonly _tag: string },
  SlotsR = never,
  SD extends SlotsDef = Record<string, never>,
> extends Omit<ResourceMachine<State, Event, SlotsR, SD>, "afterTransition"> {
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<BuiltinRuntimeEffect>
}

export const defineBuiltinResource = <
  A,
  S extends ResourceScope,
  R = never,
  E = never,
  State extends { readonly _tag: string } = { readonly _tag: string },
  Event extends { readonly _tag: string } = { readonly _tag: string },
  SlotsR = never,
  SD extends SlotsDef = Record<string, never>,
>(
  spec: Omit<ResourceSpec<A, S, R, E>, "machine"> & {
    readonly machine?: BuiltinResourceMachine<State, Event, SlotsR, SD>
  },
): ResourceContribution<A, S, R, E> =>
  // Builtins may emit runtime turn-control effects; public extension machines cannot.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- builtin-only membrane widens runtime effects before the shared Resource host consumes them.
  spec as ResourceContribution<A, S, R, E>
