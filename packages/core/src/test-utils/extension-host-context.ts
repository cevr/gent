import { Effect } from "effect"
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
  run: () => die("agent.run"),
  resolveDualModelPair: () => die("agent.resolveDualModelPair"),
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
  createBranch: () => die("session.createBranch"),
  forkBranch: () => die("session.forkBranch"),
  switchBranch: () => die("session.switchBranch"),
  createChildSession: () => die("session.createChildSession"),
  getChildSessions: () => die("session.getChildSessions"),
  getSessionAncestors: () => die("session.getSessionAncestors"),
  deleteSession: () => die("session.deleteSession"),
  deleteBranch: () => die("session.deleteBranch"),
  deleteMessages: () => die("session.deleteMessages"),
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
  ...(overrides.agentName !== undefined ? { agentName: overrides.agentName } : {}),
  ...(overrides.capabilityContext !== undefined
    ? { capabilityContext: overrides.capabilityContext }
    : {}),
  agent: { ...defaultAgent(), ...overrides.agent },
  session: { ...defaultSession(), ...overrides.session },
  interaction: { ...defaultInteraction(), ...overrides.interaction },
})
