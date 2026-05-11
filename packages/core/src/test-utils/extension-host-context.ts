import { Effect } from "effect"
import { ExtensionHostProcessError } from "../domain/extension.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import { BranchId, SessionId } from "../domain/ids.js"

type TestExtensionHostContextOverrides = Omit<
  Partial<ExtensionHostContext>,
  "agent" | "session" | "interaction"
> & {
  readonly agent?: Partial<ExtensionHostContext.Agent>
  readonly session?: Partial<ExtensionHostContext.SessionFacet>
  readonly interaction?: Partial<ExtensionHostContext.Interaction>
}

const die = (operation: string) =>
  Effect.die(new Error(`unconfigured test ExtensionHostContext.${operation}`))

const defaultAgent = (): ExtensionHostContext.Agent => ({
  get: () => die("agent.get"),
  require: () => die("agent.require"),
  listAgents: () => die("agent.listAgents"),
  run: () => die("agent.run"),
})

const defaultSession = (): ExtensionHostContext.SessionFacet => ({
  listMessages: () => die("session.listMessages"),
  getSession: () => die("session.getSession"),
  getDetail: () => die("session.getDetail"),
  renameCurrent: () => die("session.renameCurrent"),
  estimateContextPercent: () => die("session.estimateContextPercent"),
  search: () => die("session.search"),
  queueFollowUp: () => die("session.queueFollowUp"),
  listBranches: () => die("session.listBranches"),
})

const defaultInteraction = (): ExtensionHostContext.Interaction => ({
  approve: () => die("interaction.approve"),
  present: () => die("interaction.present"),
  confirm: () => die("interaction.confirm"),
  review: () => die("interaction.review"),
})

export const testExtensionHostContext = (
  overrides: TestExtensionHostContextOverrides = {},
): ExtensionHostContext => ({
  sessionId: overrides.sessionId ?? SessionId.make("test-session"),
  branchId: overrides.branchId ?? BranchId.make("test-branch"),
  cwd: overrides.cwd ?? "/tmp",
  home: overrides.home ?? "/tmp",
  host: overrides.host ?? {
    osInfo: {
      platform: "darwin",
      arch: "arm64",
      release: "test",
      hostname: "test-host",
      type: "Darwin",
    },
    execPath: "/usr/bin/node",
    homeDirectory: overrides.home ?? "/tmp",
    parentEnv: {},
    pathListSeparator: ":",
    commandCandidates: (command) => [command],
    isPortFree: () => Effect.succeed(true),
    isPidAlive: () => Effect.succeed(true),
    signalPid: () => Effect.void,
    runProcess: (command) =>
      Effect.fail(
        new ExtensionHostProcessError({
          command,
          message: "test host runProcess unavailable",
        }),
      ),
  },
  ...(overrides.agentName !== undefined ? { agentName: overrides.agentName } : {}),
  ...(overrides.capabilityContext !== undefined
    ? { capabilityContext: overrides.capabilityContext }
    : {}),
  agent: { ...defaultAgent(), ...overrides.agent },
  session: { ...defaultSession(), ...overrides.session },
  interaction: { ...defaultInteraction(), ...overrides.interaction },
})
