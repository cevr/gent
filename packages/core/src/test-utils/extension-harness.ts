import { makeFileWriter } from "../domain/file-writer.js"
/** Test helpers for extension tool execution. */

// @effect-diagnostics nodeBuiltinImport:off — test stub needs sync path ops; ExtensionFilesService captures Path.Path at runtime construction
// oxlint-disable-next-line effect/noNodeBuiltinImport -- The synchronous test host implements the platform path adapter.
import * as nodePath from "node:path"
import { Effect, FileSystem, Layer, Option } from "effect"
import type { AgentDefinition, AgentRunner } from "../domain/agent.js"
import type { GentExtension, ExtensionSetupServices } from "../domain/extension.js"
import type { ToolCapability } from "../domain/capability/tool.js"
import {
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
  type ExtensionHostContext,
} from "../domain/extension-services.js"
import { getToolMetadata } from "../domain/capability/tool.js"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "../domain/ids.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { BunPlatformLive } from "../runtime/gent-platform-bun.js"
import { LanguageModelLayers } from "./language-model.js"
import { testExtensionHostContext } from "./extension-host-context.js"
import { createDependencies } from "../server/dependencies.js"
import {
  stubAgentRunnerLayer,
  testAgentsExtension,
  testEnvironment,
  testOverrides,
} from "./test-root.js"
import { noBranchTools, type BranchToolFeature } from "../runtime/agent/branch-tool-feature.js"

export interface ToolTestLayerConfig {
  /**
   * The branch-tool feature this harness installs. Defaults to
   * `noBranchTools`; a test exercising a real feature names it.
   */
  readonly branchTools?: BranchToolFeature<never>
  /** Agents to register */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extensions to load */
  readonly extensions?: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /** Extra tools to register (authored via `tool({...})`). */
  readonly tools?: ReadonlyArray<ToolCapability>
  /** AgentRunner mock — default returns success with empty text */
  readonly subagentRunner?: Pick<AgentRunner, "run">
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/**
 * Create a test layer for extension tool execution.
 *
 * Provides core services needed by most tools. Tools that need platform
 * services (FileSystem, Path) should compose with BunServices.layer.
 */
export const createToolTestLayer = (config: ToolTestLayerConfig) =>
  createDependencies({
    ...testEnvironment,
    persistenceMode: "memory",
    languageModelLayerOverride: LanguageModelLayers.debug(),
    extensions: [testAgentsExtension(config.agents, config.tools), ...(config.extensions ?? [])],
    branchTools: config.branchTools ?? noBranchTools,
    overrides: {
      ...testOverrides(),
      toolRunnerLayer: ToolRunner.Test(),
      agentRunnerLayer: stubAgentRunnerLayer(config.subagentRunner),
      extraLayers: config.extraLayers,
    },
  }).pipe(Layer.provide(BunPlatformLive), Layer.orDie)

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)
const dieEffect = (label: string) => Effect.die(`${label} not wired in test`)

export type TestToolContext = ExtensionHostContext &
  ExtensionContextService & { readonly toolCallId: ToolCallId }

type TestToolContextOverrides = Omit<Partial<TestToolContext>, "Agent"> & {
  readonly Agent?: Partial<TestToolContext["Agent"]>
}

/** Default ToolCapabilityContext for tests — overridable via spread */
export const testToolContext = (overrides?: TestToolContextOverrides): TestToolContext => {
  const host = testExtensionHostContext().host
  const Agent: ExtensionContextService["Agent"] = {
    listAgents: dieEffect("agent.listAgents"),
    start: dieStub("agent.start"),
    inspect: dieStub("agent.inspect"),
    list: dieStub("agent.list"),
    cancel: dieStub("agent.cancel"),
    run: dieStub("agent.run"),
  }
  const Session: ExtensionContextService["Session"] = {
    getSession: dieStub("session.getSession"),
    getDetail: dieStub("session.getDetail"),
    renameCurrent: dieStub("session.renameCurrent"),
    search: dieStub("session.search"),
    queueFollowUp: dieStub("session.queueFollowUp"),
    dequeueFollowUp: dieStub("session.dequeueFollowUp"),
    listBranches: dieEffect("session.listBranches"),
    listSessions: dieEffect("session.listSessions"),
    listActiveLoops: dieEffect("session.listActiveLoops"),
  }
  const Interaction: ExtensionContextService["Interaction"] = {
    approve: dieStub("Interaction.approve"),
    present: dieStub("Interaction.present"),
  }
  const process: ExtensionContextService["Process"] = {
    randomId: host.randomId,
    run: (command, args, options) =>
      host.runProcess(command, args, options).pipe(
        Effect.mapError(
          (cause) =>
            new ExtensionServiceError({
              service: "ExtensionProcess",
              operation: "run",
              message: cause.message,
              cause,
            }),
        ),
      ),
    parentEnv: host.parentEnv,
  }
  const filesError = (operation: string) => (cause: unknown) => {
    let message = String(cause)
    if (cause instanceof Error) message = cause.message
    return new ExtensionServiceError({
      service: "ExtensionFiles",
      operation,
      message,
      cause,
    })
  }
  const filesFs = <A, E>(
    operation: string,
    op: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>,
  ) =>
    Effect.serviceOption(FileSystem.FileSystem).pipe(
      Effect.flatMap((opt) => {
        if (Option.isSome(opt)) {
          return op(opt.value).pipe(Effect.mapError(filesError(operation)))
        }
        return Effect.fail(filesError(operation)("FileSystem service unavailable in test"))
      }),
    )
  const files: ExtensionContextService["Files"] = {
    read: (path) => filesFs("read", (fs) => fs.readFileString(path)),
    write: (path, content, options) =>
      filesFs("write", (fs) => makeFileWriter(fs, nodePath.dirname)(path, content, options)),
    exists: (path) => filesFs("exists", (fs) => fs.exists(path)),
    stat: (path) =>
      filesFs("stat", (fs) =>
        fs.stat(path).pipe(
          Effect.map((info) => ({
            type: info.type,
            size: info.size,
            mtime: Option.getOrUndefined(info.mtime),
          })),
        ),
      ),
    makeDirectory: (path, options) =>
      filesFs("makeDirectory", (fs) => fs.makeDirectory(path, options)),
    rename: (from, to) => filesFs("rename", (fs) => fs.rename(from, to)),
    resolve: (...paths) => nodePath.resolve(...paths),
    join: (...paths) => nodePath.join(...paths),
    dirname: (path) => nodePath.dirname(path),
  }
  const fileLock: ExtensionContextService["FileLock"] = {
    withLock: (_path, effect) => effect,
  }
  const state: ExtensionContextService["State"] = {
    changed: () => Effect.void,
  }
  const resolvedAgent = { ...Agent, ...overrides?.Agent }
  const resolvedSession = overrides?.Session ?? Session
  const resolvedInteraction = overrides?.Interaction ?? Interaction
  const resolvedProcess = overrides?.Process ?? process
  const resolvedFiles = overrides?.Files ?? files
  const resolvedFileLock = overrides?.FileLock ?? fileLock
  const resolvedState = overrides?.State ?? state
  const resolvedExtensionId = overrides?.extensionId ?? ExtensionId.make("test-extension")

  return {
    extensionId: resolvedExtensionId,
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/tmp",
    home: "/tmp",
    host,
    Session: resolvedSession,
    Interaction: resolvedInteraction,
    Process: resolvedProcess,
    Files: resolvedFiles,
    FileLock: resolvedFileLock,
    State: resolvedState,
    ...overrides,
    Agent: resolvedAgent,
  }
}

/**
 * Test-only adapter for invoking a tool's effect with a wired
 * `ExtensionContext`. Production wraps tool execution in
 * `provideExtensionServices`; tests provide the service directly so mocks
 * stay observable. Keep this helper test-only — production code never wires
 * `ExtensionContext` at the tool boundary.
 */
export const runToolWithCtx = <Input, Output, Error>(
  tool: ToolCapability<Input, Output, Error>,
  input: Input,
  ctx: ExtensionContextService,
): Effect.Effect<Output, Error, never> =>
  getToolMetadata(tool).effect(input).pipe(Effect.provideService(ExtensionContext, ctx))
