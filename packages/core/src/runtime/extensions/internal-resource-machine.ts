import type { SlotsDef } from "effect-machine"
import type {
  ResourceContribution,
  ResourceScope,
  ResourceSpec,
  ResourceMachine,
} from "../../domain/resource.js"
import type { RuntimeExtensionEffect } from "./runtime-effect.js"

export interface InternalResourceMachine<
  State extends { readonly _tag: string } = { readonly _tag: string },
  Event extends { readonly _tag: string } = { readonly _tag: string },
  SlotsR = never,
  SD extends SlotsDef = Record<string, never>,
> extends Omit<ResourceMachine<State, Event, SlotsR, SD>, "afterTransition"> {
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<RuntimeExtensionEffect>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InternalAnyResourceMachine = InternalResourceMachine<any, any, any, any>

export const defineInternalResource = <A, S extends ResourceScope, R = never, E = never>(
  spec: Omit<ResourceSpec<A, S, R, E>, "machine"> & {
    readonly machine?: InternalAnyResourceMachine
  },
): ResourceContribution<A, S, R, E> =>
  // Internal membrane: builtins may declare runtime-only follow-up effects; external authors may not.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- this is the single widening point from internal runtime effects back to the public contribution shape.
  spec as ResourceContribution<A, S, R, E>
