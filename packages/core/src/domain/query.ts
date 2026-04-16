/**
 * QueryContribution — typed read-only RPC over services.
 *
 * Replaces the actor-as-RPC-dispatcher pattern (a stateless effect-machine
 * actor whose only job was to map an `ExtensionMessage.reply` request to a
 * service call). Queries:
 *
 *   1. Have a `handler` Effect that reads from services and produces an
 *      `Output`. Read-only by lint rule (mirror of `ProjectionContribution`).
 *   2. Have schema-typed `input` and `output` so callers get typed responses
 *      via `ctx.extension.query(QueryRef, input)`.
 *   3. Are evaluated on demand by `QueryRegistry.run(extensionId, queryId,
 *      input)`. There is no actor lifecycle, no persistence, no fiber.
 *
 * Subtraction-before-addition: queries collapse the
 *   (Schema → ExtensionMessage.reply → mapRequest → Machine event handler →
 *    slot fn → service call → Machine.reply)
 * stack into (Schema → Effect → service call → return).
 *
 * @module
 */
import { type Effect, Schema } from "effect"
import type { BranchId, SessionId } from "./ids.js"

/** Failure raised by a query handler. Carries query id + cause for diagnostics. */
export class QueryError extends Schema.TaggedErrorClass<QueryError>()(
  "@gent/core/src/domain/query/QueryError",
  {
    extensionId: Schema.String,
    queryId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Failure raised when a query is invoked with an id that has no contribution. */
export class QueryNotFoundError extends Schema.TaggedErrorClass<QueryNotFoundError>()(
  "@gent/core/src/domain/query/QueryNotFoundError",
  {
    extensionId: Schema.String,
    queryId: Schema.String,
  },
) {}

/** Context handed to a query's `handler` Effect.
 *
 *  Read-only by design — no mutation/control surfaces here. Query authors
 *  needing to write state should be authoring a `MutationContribution` instead.
 */
export interface QueryContext {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  /** Process working directory (host cwd). */
  readonly cwd: string
  /** User home directory. */
  readonly home: string
}

/** A typed read-only RPC contributed by an extension.
 *
 *  - `Input` and `Output` are validated at the registry boundary
 *  - `R` is the service requirement of the `handler` Effect; provided by the
 *    extension's contributed `layer`
 *  - the handler must be read-only — no `.create(`, `.update(`, `.delete(`,
 *    `.set(`, `.write(` calls on service interfaces. Enforced by
 *    `gent/no-projection-writes`, which scans `QueryContribution.handler`
 *    bodies for write-shaped method calls (same rule as projections — both
 *    are read surfaces).
 */
export interface QueryContribution<Input = unknown, Output = unknown, R = never> {
  /** Stable id (extension-local). Used for routing. */
  readonly id: string
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Schema<Input>
  /** Schema for validating `output` at the boundary. */
  readonly output: Schema.Schema<Output>
  /** Read-only Effect producing the output. The Effect's requirement `R` is
   *  provided by the runtime — typically an extension-contributed service Layer. */
  readonly handler: (input: Input, ctx: QueryContext) => Effect.Effect<Output, QueryError, R>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyQueryContribution = QueryContribution<any, any, any>

/** Reference object handed to callers — pairs the extension id with the query
 *  contribution so `ctx.extension.query(ref, input)` can route + decode. */
export interface QueryRef<Input = unknown, Output = unknown> {
  readonly extensionId: string
  readonly queryId: string
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
}
