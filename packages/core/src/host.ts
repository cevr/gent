/**
 * What a host needs to compose and run gent: the platform, the config
 * loader, storage, workspace headers, the server root, and the scripted
 * language model `Gent.provider.mock()` ships. Clients read `protocol`;
 * extensions read `extensions/api`; tests read `test-utils`.
 */
export {
  GentPlatform,
  resolveDataDir,
  type RuntimeModuleSource,
  writeFileAtomic,
} from "./runtime/gent-platform.js"
export { bindBunModules, BunPlatformLive } from "./runtime/gent-platform-bun.js"
export {
  hasProjectScope,
  isProjectExtensionDirectoryTrusted,
  readDisabledExtensions,
} from "./runtime/config.js"
export { extensionEntryModules } from "./runtime/extension-host.js"
export { ModelResolver, ScriptedLanguageModel } from "./runtime/provider.js"
export { BranchStorage, MessageStorage, SessionStorage } from "./storage/storage.js"
export {
  provideWorkspaceIdHeader,
  WORKSPACE_ID_HEADER,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
} from "./server/workspace-rpc.js"
export {
  buildServerRoutes,
  createDependencies,
  makeInProcessClient,
  RpcHandlersLive,
  StateLocation,
} from "./server/server.js"
