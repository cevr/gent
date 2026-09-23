/**
 * The test harness: in-process layers, the RPC acceptance harness, scripted
 * language models, step builders, fixtures, and the core internals tests
 * assert against. Product code never imports this entry.
 */
export {
  baseLocalLayer,
  baseLocalLayerWithProvider,
  captureTurnTools,
  collectTestContributions,
  createE2ELayer,
  createRpcHarness,
  type E2ELayerConfig,
  ensureStorageParents,
  plantInFlightTurn,
  plantToolCallBinding,
  recordInteractionDecision,
  runtimeHostContext,
  runToolWithCtx,
  staticToolBinding,
  storedEvents,
  testHostFacts,
  testLeafContext,
  testToolContext,
  type TestToolContext,
} from "./harness.js"
export {
  type CapturedRequest,
  createWorkerEnv,
  fakeFetchLayer,
  type FakeFetchState,
  LanguageModelLayers,
  makeFakeFetchState,
  makeTempDirectoryScoped,
  multiToolCallStep,
  oneGenerate,
  type SequenceStep,
  textStep,
  toolCallStep,
  waitFor,
} from "./language-model.js"
export { finishPart, textDeltaPart, toolCallPart } from "../runtime/provider.js"
export { type LoadedExtension } from "../domain/extension.js"
export { ApprovalService } from "../runtime/extension-host.js"
export { BunGentPlatformLive } from "../runtime/gent-platform-bun.js"
export { ConfigService, RuntimeEnvironment, UserConfig } from "../runtime/config.js"
export { EventPublisherLive, EventStore, type EventStoreService } from "../domain/event.js"
export { SqliteStorage } from "../storage/storage.js"
export { CurrentWorkspaceId, WORKSPACE_ID_HEADER, WorkspaceId } from "../server/workspace-rpc.js"
