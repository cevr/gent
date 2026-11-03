import { Context, Effect, Option, Schema } from "effect"
import { Headers } from "effect/http"
import { RpcMiddleware } from "effect/rpc"
import { StorageError } from "../domain/errors.js"
import { CurrentWorkspaceId, SessionId, WorkspaceId } from "../domain/ids.js"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- a client and its server derive the wire id in separate processes; it is pinned to node:crypto sha256, not an adapter's hash
import { createHash } from "node:crypto"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- sync, context-free canonicalization: the wire id must not depend on a Path layer being wired
import { resolve as resolvePath } from "node:path"

export const WORKSPACE_ID_HEADER = "x-gent-workspace-id"

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
 * silently. The import and the call carry line-local lint suppressions for
 * exactly that reason.
 *
 * Sync because SDK client construction needs it outside an Effect context.
 */
export const workspaceIdForCwd = (cwd: string): WorkspaceId =>
  WorkspaceId.make(createHash("sha256").update(resolvePath(cwd)).digest("hex"))

/**
 * The header set a client sends for `cwd`. `Headers.fromInput` and the RPC
 * client both want plain string values, so the id goes out unbranded; the
 * set is still a plain string record wherever one is wanted.
 * `workspaceIdForCwd` keeps the branded value for callers that need it.
 */
type WorkspaceHeaders = { readonly [WORKSPACE_ID_HEADER]: string }

export const workspaceHeadersForCwd = (cwd: string): WorkspaceHeaders => ({
  [WORKSPACE_ID_HEADER]: String(workspaceIdForCwd(cwd)),
})

class WorkspaceHeaderError extends Schema.TaggedError<
  WorkspaceHeaderError,
  { readonly brand: unique symbol }
>()("WorkspaceHeaderError", {
  message: Schema.String,
}) {}

const validateWorkspaceId = (
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

/** The header a link's requests carry: the machine of the server that sent them (server/link.ts). */
export const LINK_ORIGIN_HEADER = "x-gent-link"

/**
 * The machine a request came from over a link (`LINK_ORIGIN_HEADER`), none
 * for a local client's. A server serves such a request itself and never
 * sends it on over a link of its own: that stops a loop A → B → A.
 */
export const CurrentLinkOrigin = Context.Reference<Option.Option<string>>(
  "@gent/core/src/server/workspace-rpc/CurrentLinkOrigin",
  { defaultValue: () => Option.none() },
)

/** Provides `CurrentLinkOrigin` from a request's headers. */
export const provideLinkOrigin =
  (headers: Headers.Headers) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentLinkOrigin, Headers.get(headers, LINK_ORIGIN_HEADER))

const decodeSessionField = Schema.decodeUnknownOption(Schema.Struct({ sessionId: SessionId }))
const decodeCommandField = Schema.decodeUnknownOption(
  Schema.Struct({ command: Schema.Struct({ sessionId: SessionId }) }),
)
const decodeSessionScope = Schema.decodeUnknownOption(
  Schema.Struct({ scope: Schema.TaggedStruct("Session", { id: SessionId }) }),
)
const decodeParentField = Schema.decodeUnknownOption(Schema.Struct({ parentSessionId: SessionId }))

/**
 * The session an RPC request names, in the four shapes the contract uses: a
 * `sessionId` field, a steer command's `sessionId`, a `Session` status
 * scope, or a child create's `parentSessionId` (a child lives in its parent's
 * workspace, where every thread query finds it). None for a server-scoped call
 * (a root `session.create`, `session.list`, the pool and auth-store calls).
 */
export const sessionNamedBy = (request: { readonly payload: unknown }): Option.Option<SessionId> =>
  Option.firstSomeOf([
    decodeSessionField(request.payload).pipe(Option.map(({ sessionId }) => sessionId)),
    decodeCommandField(request.payload).pipe(Option.map(({ command }) => command.sessionId)),
    decodeSessionScope(request.payload).pipe(Option.map(({ scope }) => scope.id)),
    decodeParentField(request.payload).pipe(Option.map(({ parentSessionId }) => parentSessionId)),
  ])

/**
 * Provides `CurrentWorkspaceId` to every RPC handler. The header names the
 * client's workspace; a call that names a stored session runs in the
 * workspace that session is stored under instead, so a client in any
 * directory reaches the one loop of the session. It provides
 * `CurrentLinkOrigin` too. The server composes the
 * layer (`RpcHandlersLive`), because it reads the session store.
 */
export class WorkspaceRpcMiddleware extends RpcMiddleware.Service<WorkspaceRpcMiddleware>()(
  "@gent/core/src/server/workspace-rpc/WorkspaceRpcMiddleware",
  { error: Schema.Union([WorkspaceHeaderError, StorageError]) },
) {}
