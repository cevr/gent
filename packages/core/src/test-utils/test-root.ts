/**
 * What every test composition root shares: a `/tmp` environment, the stub
 * service layers, a deterministic server identity, an agents/tools
 * extension, and a stub agent runner. The roots in `in-process-layer`,
 * `e2e-layer`, and `extension-harness` are deltas over these.
 */
import { Effect, Layer } from "effect"
import {
  AgentRunnerService,
  AgentRunResult,
  type AgentDefinition,
  type AgentRunner,
  DEFAULT_AGENT_NAME,
} from "../domain/agent.js"
import { Auth } from "../domain/auth.js"
import type { ToolCapability } from "../domain/capability/tool.js"
import { SessionId } from "../domain/ids.js"
import { defineExtension, ExtensionHost } from "../extensions/api.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"

export const testEnvironment = { cwd: "/tmp", home: "/tmp", platform: "test" }

export const testIdentity = (dbPath: string = ":memory:") => ({
  serverId: "test-server",
  pid: 0,
  hostname: "test-host",
  dbPath,
  buildFingerprint: "test-fingerprint",
  startedAt: 0,
})

/** Fresh stub layers per call: `ApprovalService.Test()` carries a decision queue. */
export const testOverrides = () => ({
  authLayer: Auth.Test(),
  approvalLayer: ApprovalService.Test(),
  configServiceLayer: ConfigService.Test(),
  modelRegistryLayer: ModelRegistry.Test(),
})

export const testAgentsExtension = (
  agents: ReadonlyArray<AgentDefinition>,
  tools: ReadonlyArray<ToolCapability> = [],
) =>
  defineExtension({
    id: "test-agents",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("agent", ...agents)
      yield* host.register("tool", ...tools)
    }),
  })

const defaultRun: Pick<AgentRunner, "run"> = {
  run: () =>
    Effect.succeed(
      AgentRunResult.cases.Success.make({
        text: "",
        sessionId: SessionId.make("test-subagent-session"),
        agentName: DEFAULT_AGENT_NAME,
      }),
    ),
}

/** An agent runner whose `run` answers (empty success by default) and whose other methods die. */
export const stubAgentRunnerLayer = (
  runner: Pick<AgentRunner, "run"> = defaultRun,
): Layer.Layer<AgentRunnerService> =>
  Layer.succeed(
    AgentRunnerService,
    AgentRunnerService.of({
      start: () => Effect.die("AgentRunner.start not configured in test"),
      inspect: () => Effect.die("AgentRunner.inspect not configured in test"),
      list: () => Effect.die("AgentRunner.list not configured in test"),
      cancel: () => Effect.die("AgentRunner.cancel not configured in test"),
      send: () => Effect.die("AgentRunner.send not configured in test"),
      ...runner,
    }),
  )
