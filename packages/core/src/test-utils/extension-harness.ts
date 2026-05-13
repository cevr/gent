/** Test helpers for extension tool execution. */

// @effect-diagnostics nodeBuiltinImport:off — test stub needs sync path ops; ExtensionFilesService captures Path.Path at runtime construction
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
import { EventStore } from "../domain/event.js"
import type { LoadedExtension, GentExtension } from "../domain/extension.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import { type ExtensionContributions } from "../domain/contribution.js"
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
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { AgentLoopTestActor } from "../runtime/agent/agent-loop.actor.js"
import { AgentLoopSessionGovernance } from "../runtime/agent/agent-loop.session-governance.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
} from "../runtime/extensions/activation.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { BunGentPlatformLive, BunPlatformLive } from "../runtime/gent-platform-bun.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { EventPublisherLive } from "../domain/event-publisher.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { LanguageModelLayers } from "./language-model.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"
import { testExtensionHostContext } from "./extension-host-context.js"

export interface ToolTestLayerConfig {
  /** Agents to register */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extensions to load */
  readonly extensions?: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  /** Extra tools to register (authored via `tool({...})`). */
  readonly tools?: ReadonlyArray<ToolCapability>
  /** AgentRunner mock — default returns success with empty text */
  readonly subagentRunner?: AgentRunner
  /** Extra layers to merge (e.g., GitReader.Test) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/**
 * Create a test layer for extension tool execution.
 *
 * Provides core services needed by most tools. Tools that need platform
 * services (FileSystem, Path) should compose with BunServices.layer.
 */
export const createToolTestLayer = (config: ToolTestLayerConfig) => {
  const builtinContributions: ExtensionContributions = {
    agents: config.agents,
    ...((config.tools ?? []).length > 0 ? { tools: config.tools } : {}),
  }

  const defaultRunner: AgentRunner = {
    run: () =>
      Effect.succeed(
        AgentRunResult.cases.success.make({
          text: "",
          sessionId: SessionId.make("test-subagent-session"),
          agentName: AgentName.make("cowork"),
        }),
      ),
  }
  const subagentRunnerLayer = Layer.succeed(
    AgentRunnerService,
    config.subagentRunner ?? defaultRunner,
  )

  return Layer.unwrap(
    Effect.gen(function* () {
      const setupResult = yield* setupBuiltinExtensions({
        extensions: config.extensions ?? [],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      const allExtensions: LoadedExtension[] = [
        {
          manifest: { id: ExtensionId.make("test-agents") },
          scope: "builtin" as const,
          sourcePath: "test",
          contributions: builtinContributions,
        },
        ...setupResult.active,
      ]

      const reconciled = yield* reconcileLoadedExtensions({
        extensions: allExtensions,
        failedExtensions: setupResult.failed,
        home: "/tmp",
        command: undefined,
      })

      const activeExtensions = reconciled.resolved.extensions
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const extensionRegistryLayer = ExtensionRegistry.fromResolved(reconciled.resolved)
      const driverRegistryLayer = DriverRegistry.fromResolved(reconciled.resolved)
      const languageModelLayer = LanguageModelLayers.debug()
      const baseDepsLayer = Layer.mergeAll(
        storageLayer,
        EventStore.Memory,
        extensionRegistryLayer,
        driverRegistryLayer,
        subagentRunnerLayer,
        PromptPresenter.Test(),
        Permission.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        languageModelLayer,
        ModelResolver.fromLanguageModel(languageModelLayer),
        ToolRunner.Test(),
        ConfigService.Test(),
        ModelRegistry.Test(),
        // Required for resource layers below: `Layer.provideMerge(r.layer,
        // baseLayerAny)` (line 123) feeds extension Resource layers from
        // `baseLayerAny`, and many of them yield `GentPlatform`. Outer
        // `Layer.provide(BunPlatformLive)` only reaches outer requirements,
        // not the requirements satisfied INSIDE `provideMerge`.
        BunGentPlatformLive,
        ...(config.extraLayers ?? []),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDepsLayer)
      const baseWithRuntimeLayer = Layer.mergeAll(
        baseDepsLayer,
        eventPublisherLayer,
        AgentLoopSessionGovernance.Live,
      )
      const agentLoopLayer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(baseWithRuntimeLayer),
      )
      const baseLayer = Layer.merge(baseWithRuntimeLayer, agentLoopLayer)
      const baseLayerAny: Layer.Layer<never, never, object> = baseLayer

      const contributedLayers: Array<Layer.Layer<never, never, object>> = activeExtensions.flatMap(
        (ext) =>
          (ext.contributions.resources ?? [])
            .filter((r) => r.scope === "process")
            .map((r) => {
              // Resource layers carry their own R/E; harness boundary.
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
              const merged = Layer.provideMerge(r.layer as Layer.Layer<any>, baseLayerAny) // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
              return merged as Layer.Layer<never, never, object>
            }),
      )

      let extensionLayer: Layer.Layer<never, never, object> | undefined
      for (const layer of contributedLayers) {
        extensionLayer = extensionLayer === undefined ? layer : Layer.merge(extensionLayer, layer)
      }

      return extensionLayer === undefined ? baseLayerAny : Layer.merge(baseLayerAny, extensionLayer)
    }),
  ).pipe(Layer.provide(BunPlatformLive))
}

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

export type TestToolContext = ExtensionHostContext &
  ExtensionContextService & { readonly toolCallId: ToolCallId }

/** Default ToolCapabilityContext for tests — overridable via spread */
export const testToolContext = (overrides?: Partial<TestToolContext>): TestToolContext => {
  const host = testExtensionHostContext().host
  const agent = {
    listAgents: dieStub("agent.listAgents"),
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
  const interaction = {
    approve: dieStub("interaction.approve"),
    present: dieStub("interaction.present"),
    confirm: dieStub("interaction.confirm"),
    review: dieStub("interaction.review"),
  }
  const process: ExtensionContextService["Process"] = {
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
  const filesError = (operation: string) => (cause: unknown) =>
    new ExtensionServiceError({
      service: "ExtensionFiles",
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    })
  const filesFs = <A, E>(
    operation: string,
    op: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>,
  ) =>
    Effect.serviceOption(FileSystem.FileSystem).pipe(
      Effect.flatMap((opt) =>
        Option.isSome(opt)
          ? op(opt.value).pipe(Effect.mapError(filesError(operation)))
          : Effect.fail(filesError(operation)(new Error("FileSystem service unavailable in test"))),
      ),
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
  const resolvedAgent = overrides?.Agent ?? agent
  const resolvedSession = overrides?.Session ?? session
  const resolvedInteraction = overrides?.Interaction ?? interaction
  const resolvedProcess = overrides?.Process ?? process
  const resolvedFiles = overrides?.Files ?? files
  const resolvedFileLock = overrides?.FileLock ?? fileLock
  const resolvedState = overrides?.State ?? state
  const resolvedDynamic = overrides?.Dynamic ?? dynamic

  return {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/tmp",
    home: "/tmp",
    host,
    agent,
    session,
    interaction,
    Agent: resolvedAgent,
    Session: resolvedSession,
    Interaction: resolvedInteraction,
    Process: resolvedProcess,
    Files: resolvedFiles,
    FileLock: resolvedFileLock,
    State: resolvedState,
    Dynamic: resolvedDynamic,
    ...overrides,
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
