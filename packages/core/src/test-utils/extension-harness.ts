/** Test helpers for extension tool execution. */

import { Effect, Layer } from "effect"
import type { AgentDefinition, AgentRunner } from "../domain/agent.js"
import {
  ExtensionContext,
  type ExtensionContextService,
  type ExtensionHostContext,
  type ExtensionSetupServices,
  type ExtensionStateFacet,
  type GentExtension,
  provideExtensionServices,
} from "../domain/extension.js"
import { getToolMetadata, type ToolCapability } from "../domain/capability.js"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "../domain/ids.js"
import { type BranchToolFeature, noBranchTools, ToolRunner } from "../runtime/tools.js"
import { BunPlatformLive } from "../runtime/gent-platform-bun.js"
import { LanguageModelLayers } from "./language-model.js"
import {
  testExtensionFileLock,
  testExtensionFiles,
  testExtensionHostContext,
  testExtensionProcess,
  testExtensionState,
} from "./extension-host-context.js"
import { createDependencies, StateLocation } from "../server/dependencies.js"
import {
  stubAgentRunnerLayer,
  testAgentsExtension,
  testEnvironment,
  testOverrides,
} from "./test-root.js"

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
    state: StateLocation.cases.Memory.make({}),
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

/**
 * One stub that serves both halves of the boundary: a host context a runtime
 * test can provide as `CurrentExtensionHostContext`, and, through
 * `runToolWithCtx`, the leaf view a tool sees. `State` keeps the host's
 * extension-id form; `runToolWithCtx` applies the leaf id the same way
 * production does.
 */
export type TestToolContext = ExtensionHostContext &
  Omit<ExtensionContextService, "State" | "Agent"> & {
    readonly toolCallId: ToolCallId
    readonly Agent: ExtensionContextService["Agent"] & ExtensionHostContext["Agent"]
  }

type TestToolContextOverrides = Omit<Partial<TestToolContext>, "Agent" | "State"> & {
  readonly Agent?: Partial<TestToolContext["Agent"]>
  /** Accepts the flat leaf facet; it is lifted to the host's id-taking form. */
  readonly State?: ReturnType<ExtensionStateFacet>
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
    send: dieStub("agent.send"),
    run: dieStub("agent.run"),
  }
  const Session: ExtensionContextService["Session"] = {
    getSession: dieStub("session.getSession"),
    getDetail: dieStub("session.getDetail"),
    renameCurrent: dieStub("session.renameCurrent"),
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
  const resolvedAgent = { ...Agent, ...overrides?.Agent }
  const resolvedSession = overrides?.Session ?? Session
  const resolvedInteraction = overrides?.Interaction ?? Interaction
  const resolvedProcess = overrides?.Process ?? testExtensionProcess(host)
  const resolvedFiles = overrides?.Files ?? testExtensionFiles()
  const resolvedFileLock = overrides?.FileLock ?? testExtensionFileLock()
  const resolvedState = overrides?.State ?? testExtensionState()
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
    ...overrides,
    State: () => resolvedState,
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
  ctx: Omit<TestToolContext, "toolCallId"> & { readonly toolCallId?: ToolCallId },
): Effect.Effect<Output, Error, never> =>
  provideExtensionServices(ctx, getToolMetadata(tool).effect(input))

/**
 * The leaf view of a test host context, derived the way production derives it.
 * Use it where a test provides `ExtensionContext` directly instead of running
 * a tool.
 */
export const testLeafContext = (ctx: TestToolContext): ExtensionContextService =>
  Effect.runSync(provideExtensionServices(ctx, Effect.service(ExtensionContext)))
