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
  createRpcClient,
  createRpcHarness,
  type E2ELayerConfig,
  ensureStorageParents,
  plantInFlightTurn,
  plantToolCallBinding,
  provideToolDispatch,
  recordInteractionDecision,
  runtimeHostContext,
  runToolWithCtx,
  staticToolBinding,
  storedEvents,
  testAgent,
  testHostFacts,
  testLeafContext,
  testSqliteStorage,
  testToolContext,
  type TestToolContext,
  testTurnExtension,
} from "./harness.js"
export {
  type CapturedRequest,
  captureProviderStopReason,
  createWorkerEnv,
  fakeFetchLayer,
  type FakeFetchState,
  LanguageModelLayers,
  makeFakeFetchState,
  makeTempDirectoryScoped,
  multiToolCallStep,
  oneGenerate,
  seedAuthKeys,
  type SequenceStep,
  textStep,
  toolCallStep,
  turnRequestText,
  waitFor,
} from "./language-model.js"
export { finishPart, textDeltaPart, toolCallPart } from "../runtime/provider.js"
export { turnNoticesText } from "../runtime/model-context.js"
export { type LoadedExtension } from "../domain/extension.js"
export { ApprovalService } from "../runtime/extension-host.js"
export { BunGentPlatformLive } from "../runtime/gent-platform-bun.js"
export { ConfigService, RuntimeEnvironment, UserConfig } from "../runtime/config.js"
export { toolCallReceipts } from "../domain/message.js"
export { SqliteStorage } from "../storage/storage.js"
export { CurrentWorkspaceId, WorkspaceId } from "../server/workspace-rpc.js"
// Protocol values only tests read: event and error fixtures, projections.
export { type SessionRuntimeState } from "../domain/agent-loop.js"
export { DriverError, DriverFailureId } from "../domain/driver.js"
export { NotFoundError, ProviderError } from "../domain/errors.js"
export {
  ErrorOccurred,
  EventId,
  MessageReceived,
  StreamEnded,
  StreamStarted,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "../domain/event.js"
export {
  emptyQueueSnapshot,
  MessagePart,
  projectMessagesWithToolInteractions,
  toolResultMessageIdForTurn,
} from "../domain/message.js"
export { SessionRuntimeError } from "../runtime/session.js"
export { ExtensionHealth } from "../server/rpc.js"
