/**
 * The workspace id and its header both live in
 * `@gent/core-internal/server/workspace-rpc` — one derivation, shared by the
 * client that sends the header and the server that derives the same id from
 * its own launch cwd.
 */
export {
  workspaceIdForCwd,
  workspaceHeadersForCwd,
  type WorkspaceHeaders,
} from "@gent/core-internal/server/workspace-rpc.js"
