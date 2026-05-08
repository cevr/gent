// @effect-diagnostics nodeBuiltinImport:off — SDK transport computes stable local workspace ids.
import { createHash } from "node:crypto"
// @effect-diagnostics nodeBuiltinImport:off — SDK transport canonicalizes caller cwd before hashing.
import { resolve } from "node:path"
import { WORKSPACE_ID_HEADER } from "@gent/core-internal/server/workspace-rpc.js"

export type WorkspaceHeaders = Record<string, string>

export const workspaceIdForCwd = (cwd: string): string =>
  createHash("sha256").update(resolve(cwd)).digest("hex")

export const workspaceHeadersForCwd = (cwd: string): WorkspaceHeaders => ({
  [WORKSPACE_ID_HEADER]: workspaceIdForCwd(cwd),
})
