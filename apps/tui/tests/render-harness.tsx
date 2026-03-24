/** @jsxImportSource @opentui/solid */

import { beforeEach, afterEach } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Scope, ServiceMap, Stream } from "effect"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { RegistryProvider } from "../src/atom-solid"
import { KeyboardScopeProvider } from "../src/keyboard/context"
import { ThemeProvider } from "../src/theme"
import { CommandProvider } from "../src/command"
import { EnvProvider } from "../src/env/context"
import { WorkspaceProvider } from "../src/workspace"
import { ClientProvider, type GentClient } from "../src/client"
import { RouterProvider, Route, type AppRoute } from "../src/router"
import type { WorkerSupervisor } from "../src/worker/supervisor"
import type {
  MessageInfoReadonly,
  QueueSnapshotReadonly,
  SessionInfo,
  SessionSnapshot,
  SessionRuntime,
} from "@gent/sdk"
import type { GentRpcError } from "@gent/core/server/errors"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type {
  EventEnvelope,
  HandoffDecisionType,
  PermissionDecisionType,
  PromptDecisionType,
} from "@gent/core/domain/event"
import type {
  BranchInfo,
  BranchTreeNode,
  CreateSessionResult,
  QueueTarget,
  SessionTreeNode,
  SkillContent,
  SteerCommand,
} from "@gent/core/server/transport-contract"
import type { AuthAuthorizationType, AuthMethodType } from "@gent/core/domain/auth-method"
import type { AuthProviderInfoType } from "@gent/core/domain/auth-guard"
import type { Model } from "@gent/core/domain/model"
import type { PermissionRule } from "@gent/core/domain/permission"
import type { ReasoningEffortType } from "@gent/core/domain/agent"
import type { Task } from "@gent/core/domain/task"

type TestRenderSetup = Awaited<ReturnType<typeof testRender>>

let currentSetup: TestRenderSetup | undefined
let sharedServices: ServiceMap.ServiceMap<unknown> | undefined
let sharedScope: Scope.Closeable | undefined
const defaultWorkspaceCwd = new URL("../../..", import.meta.url).pathname

const emptyQueueSnapshot = (): QueueSnapshotReadonly => ({
  steering: [],
  followUp: [],
})

function noRpcError<A>(value: A): Effect.Effect<A, GentRpcError> {
  return Effect.succeed(value)
}

export const createMockClient = (overrides: Partial<GentClient> = {}): GentClient => {
  const base: GentClient = {
    sendMessage: () => noRpcError(undefined),
    createSession: () =>
      noRpcError({
        sessionId: "session-test" as SessionId,
        branchId: "branch-test" as BranchId,
        name: "Test Session",
        bypass: false,
      } satisfies CreateSessionResult),
    listMessages: () => noRpcError([] satisfies readonly MessageInfoReadonly[]),
    getSessionSnapshot: () =>
      noRpcError({
        sessionId: "session-test" as SessionId,
        branchId: "branch-test" as BranchId,
        messages: [],
        lastEventId: null,
        bypass: false,
        reasoningLevel: undefined,
      } satisfies SessionSnapshot),
    getSession: () => noRpcError(null),
    listSessions: () => noRpcError([] satisfies readonly SessionInfo[]),
    getChildSessions: () => noRpcError([] satisfies readonly SessionInfo[]),
    getSessionTree: () =>
      noRpcError({
        id: "session-test",
        name: "Test Session",
        children: [],
      } satisfies SessionTreeNode),
    listModels: () => noRpcError([] satisfies readonly Model[]),
    listBranches: () => noRpcError([] satisfies readonly BranchInfo[]),
    listTasks: () => noRpcError([] satisfies ReadonlyArray<Task>),
    getBranchTree: () => noRpcError([] satisfies readonly BranchTreeNode[]),
    createBranch: () => noRpcError("branch-test" as BranchId),
    switchBranch: () => noRpcError(undefined),
    forkBranch: () => noRpcError({ branchId: "branch-test" as BranchId }),
    streamEvents: () => Stream.empty as Stream.Stream<EventEnvelope, GentRpcError>,
    watchRuntime: () =>
      Stream.empty as Stream.Stream<
        SessionRuntime & { queue: QueueSnapshotReadonly },
        GentRpcError
      >,
    invokeTool: () => noRpcError(undefined),
    steer: (_command: SteerCommand) => noRpcError(undefined),
    drainQueuedMessages: (_input: QueueTarget) => noRpcError(emptyQueueSnapshot()),
    getQueuedMessages: (_input: QueueTarget) => noRpcError(emptyQueueSnapshot()),
    respondQuestions: () => noRpcError(undefined),
    respondPermission: (
      _requestId: string,
      _decision: PermissionDecisionType,
      _persist?: boolean,
    ) => noRpcError(undefined),
    respondPrompt: (_requestId: string, _decision: PromptDecisionType, _content?: string) =>
      noRpcError(undefined),
    respondHandoff: (_requestId: string, _decision: HandoffDecisionType, _reason?: string) =>
      noRpcError({}),
    updateSessionBypass: () => noRpcError({ bypass: false }),
    updateSessionReasoningLevel: (
      _sessionId: SessionId,
      reasoningLevel: ReasoningEffortType | undefined,
    ) => noRpcError({ reasoningLevel }),
    getPermissionRules: () => noRpcError([] satisfies readonly PermissionRule[]),
    deletePermissionRule: () => noRpcError(undefined),
    listAuthProviders: () => noRpcError([] satisfies readonly AuthProviderInfoType[]),
    setAuthKey: () => noRpcError(undefined),
    deleteAuthKey: () => noRpcError(undefined),
    listAuthMethods: () => noRpcError({} satisfies Record<string, ReadonlyArray<AuthMethodType>>),
    authorizeAuth: () => noRpcError(null satisfies AuthAuthorizationType | null),
    callbackAuth: () => noRpcError(undefined),
    listSkills: () =>
      noRpcError([
        {
          name: "effect-v4",
          description: "Effect skill",
          content: "effect skill content",
          filePath: "/tmp/effect-v4.md",
        },
      ] satisfies readonly SkillContent[]),
    getSkillContent: () => noRpcError(null),
    services: ServiceMap.empty(),
  }

  return { ...base, ...overrides }
}

const getServices = async () => {
  if (sharedServices !== undefined) return sharedServices
  sharedScope = await Effect.runPromise(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(BunServices.layer, sharedScope))
  sharedServices = ServiceMap.add(context, Scope.Scope, sharedScope)
  return sharedServices
}

export const renderWithProviders = async (
  node: () => JSX.Element,
  options?: {
    client?: GentClient
    initialSession?: SessionInfo
    supervisor?: WorkerSupervisor
    initialRoute?: AppRoute
    width?: number
    height?: number
    cwd?: string
  },
) => {
  const services = await getServices()
  const client = options?.client ?? createMockClient({ services })

  currentSetup = await testRender(
    () => (
      <RegistryProvider services={services}>
        <KeyboardScopeProvider>
          <ThemeProvider mode="dark">
            <EnvProvider env={{ visual: undefined, editor: undefined }}>
              <CommandProvider>
                <RouterProvider initialRoute={options?.initialRoute ?? Route.home()}>
                  <ClientProvider
                    client={client}
                    initialSession={options?.initialSession}
                    supervisor={options?.supervisor}
                  >
                    <WorkspaceProvider
                      cwd={options?.cwd ?? defaultWorkspaceCwd}
                      services={services}
                    >
                      {node()}
                    </WorkspaceProvider>
                  </ClientProvider>
                </RouterProvider>
              </CommandProvider>
            </EnvProvider>
          </ThemeProvider>
        </KeyboardScopeProvider>
      </RegistryProvider>
    ),
    {
      width: options?.width ?? 80,
      height: options?.height ?? 24,
    },
  )

  await currentSetup.renderOnce()
  await Promise.resolve()
  await currentSetup.renderOnce()
  return currentSetup
}

export const renderFrame = (setup: TestRenderSetup) =>
  setup.captureCharFrame().replaceAll("\u00a0", " ")

export const destroyRenderSetup = (setup: TestRenderSetup) => {
  if (currentSetup === setup) currentSetup = undefined
  setup.renderer.destroy()
}

beforeEach(() => {
  currentSetup = undefined
})

afterEach(() => {
  if (currentSetup !== undefined) destroyRenderSetup(currentSetup)
  currentSetup = undefined
})
