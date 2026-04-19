/**
 * SessionDeleter — domain-level deletion contract.
 *
 * Provides a one-method service for whole-session destructive cleanup. The
 * runtime's extension host context (`make-extension-host-context.ts`) needs
 * to invoke "delete this session" from inside an extension; the live
 * implementation lives in `server/session-commands.ts` because it must
 * coordinate `extensionStateRuntime.terminateAll`, `eventPublisher`,
 * `eventStore`, and `storage` — all server-tier services.
 *
 * Before this Tag, the runtime reached into `server/` via a dynamic
 * `import("../server/session-commands.js")`, breaking static analysis and
 * the `gent/no-dynamic-imports` rule's compiled-binary contract. The Tag
 * inverts the dependency: the server registers a Layer that provides
 * `SessionDeleter`, and the runtime yields the Tag (with
 * `Effect.serviceOption` for the test/headless case where no server is
 * present, in which case the caller falls back to `storage.deleteSession`).
 *
 * @module
 */
import { Context, type Effect } from "effect"
import type { SessionId } from "./ids.js"

export interface SessionDeleterService {
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void>
}

export class SessionDeleter extends Context.Service<SessionDeleter, SessionDeleterService>()(
  "@gent/core/src/domain/session-deleter/SessionDeleter",
) {}
