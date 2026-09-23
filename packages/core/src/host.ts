/**
 * What a host needs to compose and run gent: the platform, the config
 * loader, storage, auth, workspace headers, the server root, and the scripted
 * language model `Gent.provider.mock()` ships. Clients read `protocol`;
 * extensions read `extensions/api`.
 */
export { GentPlatform } from "./runtime/gent-platform.js"
export { BunGentPlatformLive, BunPlatformLive } from "./runtime/gent-platform-bun.js"
export {
  ConfigService,
  isProjectExtensionDirectoryTrusted,
  readDisabledExtensions,
  RuntimeEnvironment,
  UserConfig,
} from "./runtime/config.js"
export { Auth, AuthApi, ScriptedLanguageModel } from "./runtime/provider.js"
export { EventPublisherLive, EventStore, type EventStoreService } from "./domain/event.js"
export {
  AgentLoopQueueStorage,
  BranchStorage,
  EventStorage,
  MessageStorage,
  SessionStorage,
  SqliteStorage,
  ToolCallBindingStorage,
} from "./storage/storage.js"
export {
  CurrentWorkspaceId,
  provideWorkspaceIdHeader,
  WORKSPACE_ID_HEADER,
  type WorkspaceHeaders,
  workspaceHeadersForCwd,
  WorkspaceId,
  workspaceIdForCwd,
} from "./server/workspace-rpc.js"
export { RpcHandlersLive, StateLocation } from "./server/server.js"
export { buildServerRoot, ServerRootPlatformLayer } from "./server/server-root.js"
