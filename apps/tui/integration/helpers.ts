import { BunServices } from "@effect/platform-bun"
import { Effect, Path } from "effect"
import type { Session } from "../src/client"
import type { BranchId, SessionId } from "@gent/core/protocol"

/** The repo root, without its trailing slash: the cwd these sessions open in. */
export const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path
  return path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)))
}).pipe(Effect.provide(BunServices.layer), Effect.orDie)

export const makeSessionState = (created: {
  sessionId: SessionId
  branchId: BranchId
  name: string
}): Session => ({
  sessionId: created.sessionId,
  branchId: created.branchId,
  name: created.name,
})
