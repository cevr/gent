/** Test helpers for extension tool execution. */

// @effect-diagnostics nodeBuiltinImport:off — test stub needs sync path ops; ExtensionFilesService captures Path.Path at runtime construction
// oxlint-disable-next-line effect/noNodeBuiltinImport -- The synchronous test host implements the platform path adapter.
import * as nodePath from "node:path"
import { Effect, FileSystem, Layer, Option } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  AgentName,
  AgentRunnerService,
  AgentRunResult,
  type AgentDefinition,
  type AgentRunner,
} from "../domain/agent.js"
import type { GentExtension } from "../domain/extension.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import type { ToolCapability } from "../domain/capability/tool.js"
import {
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
} from "../domain/extension-services.js"
import { getToolEffect } from "../domain/capability/tool.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { BunPlatformLive } from "../runtime/gent-platform-bun.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { LanguageModelLayers } from "./language-model.js"
import { testExtensionHostContext } from "./extension-host-context.js"
import { Auth } from "../domain/auth.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"
import { defineExtension } from "../extensions/api.js"
import { createDependencies } from "../server/dependencies.js"

export interface ToolTestLayerConfig {
  /** Agents to register */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extensions to load */
  readonly extensions?: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  /** Extra tools to register (authored via `tool({...})`). */
  readonly tools?: ReadonlyArray<ToolCapability>
  /** AgentRunner mock — default returns success with empty text */
  readonly subagentRunner?: Pick<AgentRunner, "run">
  /** Extra layers to merge (e.g., GitReader.Test) */
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
    cwd: "/tmp",
    home: "/tmp",
    platform: "test",
    persistenceMode: "memory",
    languageModelLayerOverride: LanguageModelLayers.debug(),
    extensions: [
      defineExtension({ id: "test-agents", agents: config.agents, tools: config.tools ?? [] }),
      ...(config.extensions ?? []),
    ],
    overrides: {
      authLayer: Auth.Test(),
      approvalLayer: ApprovalService.Test(),
      configServiceLayer: ConfigService.Test(),
      modelRegistryLayer: ModelRegistry.Test(),
      permissionLayer: Permission.Test(),
      toolRunnerLayer: ToolRunner.Test(),
      agentRunnerLayer: Layer.succeed(
        AgentRunnerService,
        AgentRunnerService.of({
          start: () => Effect.die("AgentRunner.start not configured in test"),
          inspect: () => Effect.die("AgentRunner.inspect not configured in test"),
          list: () => Effect.die("AgentRunner.list not configured in test"),
          cancel: () => Effect.die("AgentRunner.cancel not configured in test"),
          ...(config.subagentRunner ?? {
            run: () =>
              Effect.succeed(
                AgentRunResult.cases.success.make({
                  text: "",
                  sessionId: SessionId.make("test-subagent-session"),
                  agentName: AgentName.make("cowork"),
                }),
              ),
          }),
        }),
      ),
      fileIndexLayer: Layer.provide(FallbackFileIndexLive, BunPlatformLive),
      extraLayers: config.extraLayers,
    },
  }).pipe(Layer.provide(BunPlatformLive), Layer.orDie)

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)
const dieEffect = (label: string) => Effect.die(`${label} not wired in test`)

export type TestToolContext = ExtensionHostContext &
  ExtensionContextService & { readonly toolCallId: ToolCallId }

type TestToolContextOverrides = Omit<Partial<TestToolContext>, "agent" | "Agent"> & {
  readonly agent?: Partial<ExtensionHostContext.Agent>
  readonly Agent?: Partial<ExtensionContextService["Agent"]>
}

/** Default ToolCapabilityContext for tests — overridable via spread */
export const testToolContext = (overrides?: TestToolContextOverrides): TestToolContext => {
  const host = testExtensionHostContext().host
  const agent = {
    listAgents: dieStub("agent.listAgents"),
    start: dieStub("agent.start"),
    inspect: dieStub("agent.inspect"),
    list: dieStub("agent.list"),
    cancel: dieStub("agent.cancel"),
    run: dieStub("agent.run"),
  }
  const session = {
    listMessages: dieStub("session.listMessages"),
    getSession: dieStub("session.getSession"),
    getDetail: dieStub("session.getDetail"),
    renameCurrent: dieStub("session.renameCurrent"),
    search: dieStub("session.search"),
    queueFollowUp: dieStub("session.queueFollowUp"),
    listBranches: dieStub("session.listBranches"),
  }
  const Agent: ExtensionContextService["Agent"] = {
    listAgents: dieEffect("agent.listAgents"),
    start: dieStub("agent.start"),
    inspect: dieStub("agent.inspect"),
    list: dieStub("agent.list"),
    cancel: dieStub("agent.cancel"),
    run: dieStub("agent.run"),
  }
  const Session: ExtensionContextService["Session"] = {
    listMessages: dieStub("session.listMessages"),
    getSession: dieStub("session.getSession"),
    getDetail: dieStub("session.getDetail"),
    renameCurrent: dieStub("session.renameCurrent"),
    search: dieStub("session.search"),
    queueFollowUp: dieStub("session.queueFollowUp"),
    listBranches: dieEffect("session.listBranches"),
  }
  const interaction = {
    approve: dieStub("interaction.approve"),
    present: dieStub("interaction.present"),
    confirm: dieStub("interaction.confirm"),
    review: dieStub("interaction.review"),
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
    signalPid: (pid, signal) =>
      host.signalPid(pid, signal).pipe(
        Effect.mapError(
          (cause) =>
            new ExtensionServiceError({
              service: "ExtensionProcess",
              operation: "signalPid",
              message: String(cause),
              cause,
            }),
        ),
      ),
    isPortFree: host.isPortFree,
    isPidAlive: host.isPidAlive,
    commandCandidates: host.commandCandidates,
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
    listFiles: () =>
      Effect.fail(
        new ExtensionServiceError({
          service: "ExtensionFiles",
          operation: "listFiles",
          message: "File index service unavailable",
        }),
      ),
    read: (path) => filesFs("read", (fs) => fs.readFileString(path)),
    write: (path, content) => filesFs("write", (fs) => fs.writeFileString(path, content)),
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
    readDirectory: (path, options) =>
      filesFs("readDirectory", (fs) => fs.readDirectory(path, options)),
    makeDirectory: (path, options) =>
      filesFs("makeDirectory", (fs) => fs.makeDirectory(path, options)),
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
  const dynamic: ExtensionContextService["Dynamic"] = {
    registerTool: () => Effect.succeed(Effect.void),
    registerRequest: () => Effect.succeed(Effect.void),
  }
  const resolvedAgent = { ...Agent, ...overrides?.Agent }
  const resolvedSession = overrides?.Session ?? Session
  const resolvedInteraction = overrides?.Interaction ?? interaction
  const resolvedProcess = overrides?.Process ?? process
  const resolvedFiles = overrides?.Files ?? files
  const resolvedFileLock = overrides?.FileLock ?? fileLock
  const resolvedState = overrides?.State ?? state
  const resolvedDynamic = overrides?.Dynamic ?? dynamic
  const resolvedExtensionId = overrides?.extensionId ?? ExtensionId.make("test-extension")

  return {
    extensionId: resolvedExtensionId,
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/tmp",
    home: "/tmp",
    host,
    session,
    interaction,
    Session: resolvedSession,
    Interaction: resolvedInteraction,
    Process: resolvedProcess,
    Files: resolvedFiles,
    FileLock: resolvedFileLock,
    State: resolvedState,
    Dynamic: resolvedDynamic,
    ...overrides,
    agent: { ...agent, ...overrides?.agent },
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
  getToolEffect(tool)(input).pipe(Effect.provideService(ExtensionContext, ctx))
