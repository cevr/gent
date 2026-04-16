/**
 * MutationContribution — typed write RPC over services.
 *
 * Replaces the actor-as-RPC-dispatcher pattern for write operations
 * (`TaskCreate`, `TaskUpdate`, `TaskDelete`, etc.). Mutations:
 *
 *   1. Have a `handler` Effect that may write to services and produces an
 *      `Output`. Unlike `QueryContribution`, writes are explicit and expected.
 *   2. Have schema-typed `input` and `output`.
 *   3. Are evaluated on demand by `MutationRegistry.run(extensionId,
 *      mutationId, input)`. No actor lifecycle, no persistence, no fiber.
 *
 * The Query/Mutation split is `composability-not-flags`: rather than one
 * untyped `ask()` channel that conflates reads and writes, the API distinguishes
 * the two at the type level. Lint (and authors) can enforce read-only
 * discipline on queries; mutations are the explicit write surface.
 *
 * @module
 */
import { type Effect, Schema } from "effect"
import type { BranchId, SessionId } from "./ids.js"

/** Failure raised by a mutation handler. */
export class MutationError extends Schema.TaggedErrorClass<MutationError>()(
  "@gent/core/src/domain/mutation/MutationError",
  {
    extensionId: Schema.String,
    mutationId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Failure raised when a mutation is invoked with an id that has no contribution. */
export class MutationNotFoundError extends Schema.TaggedErrorClass<MutationNotFoundError>()(
  "@gent/core/src/domain/mutation/MutationNotFoundError",
  {
    extensionId: Schema.String,
    mutationId: Schema.String,
  },
) {}

/** Context handed to a mutation's `handler` Effect. */
export interface MutationContext {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  /** Process working directory (host cwd). */
  readonly cwd: string
  /** User home directory. */
  readonly home: string
}

/** A typed write RPC contributed by an extension. */
export interface MutationContribution<Input = unknown, Output = unknown, R = never> {
  readonly id: string
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
  readonly handler: (input: Input, ctx: MutationContext) => Effect.Effect<Output, MutationError, R>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMutationContribution = MutationContribution<any, any, any>

/** Reference object handed to callers — pairs the extension id with the mutation
 *  contribution so `ctx.extension.mutate(ref, input)` can route + decode. */
export interface MutationRef<Input = unknown, Output = unknown> {
  readonly extensionId: string
  readonly mutationId: string
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
}
