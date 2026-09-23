import { Context, Effect, Layer, Option, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcMiddleware } from "effect/unstable/rpc"
// @effect-diagnostics nodeBuiltinImport:off — the workspace id is a wire constant, see workspaceIdForCwd
// oxlint-disable-next-line gent/no-bun-outside-adapter -- a client and its server derive the wire id in separate processes; it is pinned to node:crypto sha256, not an adapter's hash
import { createHash } from "node:crypto"
// @effect-diagnostics nodeBuiltinImport:off — the workspace id canonicalizes its cwd before hashing
// oxlint-disable-next-line effect/noNodeBuiltinImport -- sync, context-free canonicalization: the wire id must not depend on a Path layer being wired
import { resolve as resolvePath } from "node:path"

export const WORKSPACE_ID_HEADER = "x-gent-workspace-id"

const WorkspaceIdPattern = /^[a-f0-9]{64}$/
export const WorkspaceId = Schema.String.check(Schema.isPattern(WorkspaceIdPattern)).pipe(
  Schema.brand("@gent/core/server/WorkspaceId"),
)
export type WorkspaceId = typeof WorkspaceId.Type
export const DefaultWorkspaceId: WorkspaceId = WorkspaceId.make("0".repeat(64))

/**
 * Derive the workspace id for a working directory.
 *
 * This is the one owner. A client hashes its cwd into the
 * `x-gent-workspace-id` header and the server hashes its launch cwd into the
 * same id, in two different processes, and the two must agree byte for byte
 * or every request lands in the wrong workspace. That makes the derivation a
 * wire constant, not a host fact: it is pinned to `node:crypto` sha256 over
 * the resolved path rather than routed through `GentPlatform.hash`, because
 * a platform adapter that hashed differently would split the workspace
 * silently. `packages/tooling` exempts this file from the crypto guard for
 * exactly that reason.
 *
 * Sync because SDK client construction needs it outside an Effect context.
 */
export const workspaceIdForCwd = (cwd: string): WorkspaceId =>
  WorkspaceId.make(createHash("sha256").update(resolvePath(cwd)).digest("hex"))

/**
 * The header set a client sends for `cwd`. `Headers.fromInput` and the RPC
 * client both want a plain string record, so this widens deliberately at the
 * transport edge; `workspaceIdForCwd` keeps the branded value for callers
 * that need it.
 */
export type WorkspaceHeaders = Record<string, string>

export const workspaceHeadersForCwd = (cwd: string): WorkspaceHeaders => {
  const headers = { [WORKSPACE_ID_HEADER]: String(workspaceIdForCwd(cwd)) }
  return headers satisfies WorkspaceHeaders
}

export const CurrentWorkspaceId = Context.Reference<WorkspaceId>(
  "@gent/core/src/server/workspace-rpc/CurrentWorkspaceId",
  { defaultValue: () => DefaultWorkspaceId },
)

export class WorkspaceHeaderError extends Schema.TaggedError<WorkspaceHeaderError>()(
  "WorkspaceHeaderError",
  {
    message: Schema.String,
  },
) {}

export const validateWorkspaceId = (
  workspaceId: string,
): Effect.Effect<WorkspaceId, WorkspaceHeaderError> =>
  Schema.decodeEffect(WorkspaceId)(workspaceId).pipe(
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
