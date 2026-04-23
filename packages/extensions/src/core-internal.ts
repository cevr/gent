import type { SlotsDef } from "effect-machine"
import type {
  ExtensionEffect,
  MessageMetadata,
  ResourceContribution,
  ResourceMachine,
  ResourceScope,
  ResourceSpec,
} from "@gent/core/extensions/api"

export {
  EventPublisher,
  InteractionPendingReader,
  MachineExecute,
  MachineEngine,
  ToolRunner,
  type ExtensionStorage,
  type InteractionPendingReaderService,
  type PendingInteraction,
  type ToolRunnerService,
} from "../../core/src/extensions/internal.js"

type RuntimeExtensionEffect =
  | {
      readonly _tag: "QueueFollowUp"
      readonly content: string
      readonly metadata?: MessageMetadata
    }
  | { readonly _tag: "Interject"; readonly content: string }
  | ExtensionEffect

export interface InternalResourceMachine<
  State extends { readonly _tag: string } = { readonly _tag: string },
  Event extends { readonly _tag: string } = { readonly _tag: string },
  SlotsR = never,
  SD extends SlotsDef = Record<string, never>,
> extends Omit<ResourceMachine<State, Event, SlotsR, SD>, "afterTransition"> {
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<RuntimeExtensionEffect>
}

export const defineInternalResource = <
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
    readonly machine?: InternalResourceMachine<State, Event, SlotsR, SD>
  },
): ResourceContribution<A, S, R, E> =>
  // Builtins may emit runtime turn-control effects; public extension machines cannot.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Gent-owned builtin bridge widens runtime-only machine effects back into the shared contribution shape.
  spec as ResourceContribution<A, S, R, E>
