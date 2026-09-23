/**
 * The test harness: in-process layers, the RPC acceptance harness, scripted
 * language models, step builders, fixtures, and the core internals tests
 * assert against. Product code never imports this entry.
 */
export {
  baseLocalLayer,
  baseLocalLayerWithProvider,
  collectTestContributions,
  createE2ELayer,
  createRpcHarness,
  type E2ELayerConfig,
  ensureStorageParents,
  runToolWithCtx,
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
export {
  compileSystemPrompt,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../domain/capability.js"
export { ExternalToolRunner } from "../domain/driver.js"
export { type LoadedExtension } from "../domain/extension.js"
export { type ApprovalDecision, encodeInteractionDecision } from "../domain/interaction.js"
export { messageSingleText } from "../domain/message.js"
export {
  ApprovalService,
  makeExtensionHostContextProvider,
  SessionProfileCache,
  setupExtension,
  setupExtensions,
} from "../runtime/extension-host.js"
export {
  boundToolResultForModel,
  CONTEXT_WINDOW_MESSAGE_TYPE,
  estimateTokens,
  windowDetails,
} from "../runtime/model-context.js"
export { SessionRuntime } from "../runtime/session.js"
export { captureCurrentToolBinding } from "../runtime/tools.js"
export { buildTurnPromptSections, toolResultMessageIdForTurn } from "../runtime/turn.js"
