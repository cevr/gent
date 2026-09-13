import { Effect, Random } from "effect"
import { ExtensionHostProcessError, type ExtensionHostPlatform } from "../domain/extension.js"
import type {
  ExtensionHostAgentService,
  ExtensionHostContext,
  ExtensionInteractionService,
  ExtensionSessionService,
} from "../domain/extension-services.js"
import { BranchId, SessionId } from "../domain/ids.js"

type TestExtensionHostContextOverrides = Omit<
  Partial<ExtensionHostContext>,
  "Agent" | "Session" | "Interaction"
> & {
  readonly Agent?: Partial<ExtensionHostAgentService>
  readonly Session?: Partial<ExtensionSessionService>
  readonly Interaction?: Partial<ExtensionInteractionService>
}

const die = (operation: string) =>
  Effect.die(new Error(`unconfigured test ExtensionHostContext.${operation}`))

const defaultAgent = (): ExtensionHostAgentService => ({
  listAgents: die("Agent.listAgents"),
  start: () => die("Agent.start"),
  inspect: () => die("Agent.inspect"),
  list: () => die("Agent.list"),
  cancel: () => die("Agent.cancel"),
  run: () => die("Agent.run"),
})

const defaultSession = (): ExtensionSessionService => ({
  getSession: () => die("Session.getSession"),
  getDetail: () => die("Session.getDetail"),
  renameCurrent: () => die("Session.renameCurrent"),
  search: () => die("Session.search"),
  queueFollowUp: () => die("Session.queueFollowUp"),
  dequeueFollowUp: () => die("Session.dequeueFollowUp"),
  listBranches: die("Session.listBranches"),
  listSessions: die("Session.listSessions"),
  listActiveLoops: die("Session.listActiveLoops"),
})

const defaultInteraction = (): ExtensionInteractionService => ({
  approve: () => die("Interaction.approve"),
  present: () => die("Interaction.present"),
})

/** The one host platform stub: a darwin box whose `runProcess` is unavailable. */
export const testExtensionHostPlatform = (home: string = "/tmp"): ExtensionHostPlatform => ({
  osInfo: {
    platform: "darwin",
    arch: "arm64",
    release: "test",
    hostname: "test-host",
    type: "Darwin",
  },
  execPath: "/usr/bin/node",
  homeDirectory: home,
  parentEnv: {},
  randomId: Random.nextInt.pipe(Effect.map((value) => `test-${value}`)),
  pathListSeparator: ":",
  runProcess: (command) =>
    Effect.fail(
      new ExtensionHostProcessError({
        command,
        message: "test host runProcess unavailable",
      }),
    ),
})

export const testExtensionHostContext = (
  overrides: TestExtensionHostContextOverrides = {},
): ExtensionHostContext => ({
  sessionId: overrides.sessionId ?? SessionId.make("test-session"),
  branchId: overrides.branchId ?? BranchId.make("test-branch"),
  cwd: overrides.cwd ?? "/tmp",
  home: overrides.home ?? "/tmp",
  host: overrides.host ?? testExtensionHostPlatform(overrides.home),
  agentName: overrides.agentName,
  Agent: { ...defaultAgent(), ...overrides.Agent },
  Session: { ...defaultSession(), ...overrides.Session },
  Interaction: { ...defaultInteraction(), ...overrides.Interaction },
})
