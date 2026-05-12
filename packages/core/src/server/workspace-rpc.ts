import { Context, Effect, Layer, Option, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcMiddleware } from "effect/unstable/rpc"

export const WORKSPACE_ID_HEADER = "x-gent-workspace-id"

const WorkspaceIdPattern = /^[a-f0-9]{64}$/
export const WorkspaceId = Schema.String.check(Schema.isPattern(WorkspaceIdPattern)).pipe(
  Schema.brand("@gent/core/server/WorkspaceId"),
)
export type WorkspaceId = typeof WorkspaceId.Type
export const DefaultWorkspaceId: WorkspaceId = WorkspaceId.make("0".repeat(64))

export const CurrentWorkspaceId = Context.Reference<WorkspaceId>(
  "@gent/core/src/server/workspace-rpc/CurrentWorkspaceId",
  { defaultValue: () => DefaultWorkspaceId },
)

export class WorkspaceHeaderError extends Schema.TaggedErrorClass<WorkspaceHeaderError>()(
  "WorkspaceHeaderError",
  {
    message: Schema.String,
  },
) {}

export const validateWorkspaceId = (
  workspaceId: string,
): Effect.Effect<WorkspaceId, WorkspaceHeaderError> =>
  Schema.decodeUnknownEffect(WorkspaceId)(workspaceId).pipe(
    Effect.mapError(
      () =>
        new WorkspaceHeaderError({
          message: `Invalid ${WORKSPACE_ID_HEADER} header`,
        }),
    ),
  )

export const provideWorkspaceIdHeader =
  (headers: Headers.Headers) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | WorkspaceHeaderError, R> =>
    Option.match(Headers.get(headers, WORKSPACE_ID_HEADER), {
      onNone: () =>
        Effect.fail(
          new WorkspaceHeaderError({
            message: `Missing ${WORKSPACE_ID_HEADER} header`,
          }),
        ),
      onSome: (workspaceId) =>
        validateWorkspaceId(workspaceId).pipe(
          Effect.andThen((valid) => Effect.provideService(effect, CurrentWorkspaceId, valid)),
        ),
    })

export class WorkspaceRpcMiddleware extends RpcMiddleware.Service<WorkspaceRpcMiddleware>()(
  "@gent/core/src/server/workspace-rpc/WorkspaceRpcMiddleware",
  { error: WorkspaceHeaderError },
) {
  static Live = Layer.succeed(WorkspaceRpcMiddleware, (effect, options) =>
    effect.pipe(provideWorkspaceIdHeader(options.headers)),
  )
}
