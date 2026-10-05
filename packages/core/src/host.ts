/**
 * What a host needs to compose and run gent: the platform, the config
 * loader, storage, workspace headers, the server root, and the scripted
 * language model `Gent.provider.mock()` ships. A Bun process adds
 * `host-bun`; nothing here loads Bun. Clients read `protocol`;
 * extensions read `extensions/api`; tests read `test-utils`.
 */
export {
  GentPlatform,
  resolveDataDir,
  type RuntimeModuleSource,
  writeFileAtomic,
} from "./runtime/gent-platform.js"
export {
  hasProjectScope,
  isProjectExtensionDirectoryTrusted,
  readDisabledExtensions,
} from "./runtime/config.js"
export {
  buildExtensionModule,
  extensionEntryModules,
  extensionModuleChanged,
  makeModuleGraphs,
  type ModuleGraphs,
} from "./runtime/extension-host.js"
export { ModelRegistry, ModelResolver, ScriptedLanguageModel } from "./runtime/provider.js"
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
} from "./server/server.js"
