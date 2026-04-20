import { Console, Effect, Option } from "effect"
import type { AgentName } from "@gent/core/domain/agent.js"
import { SessionId } from "@gent/core/domain/ids.js"
import type { BranchId } from "@gent/core/domain/ids.js"
import type { ProviderId } from "@gent/core/domain/model.js"
import type { GentNamespacedClient, GentRpcError, BranchInfo, SessionInfo } from "@gent/sdk"
import type { Session } from "./client/index"
import { Route } from "./router/index"
import type { AppRoute } from "./router/index"

export type InitialState =
  | { _tag: "session"; session: SessionInfo; prompt?: string }
  | {
      _tag: "branchPicker"
      session: SessionInfo
      branches: readonly BranchInfo[]
      prompt?: string
    }
  | { _tag: "headless"; session: SessionInfo; prompt: string }

export interface AppBootstrap {
  readonly initialSession: Session | undefined
  readonly initialRoute: AppRoute
  readonly debugMode: boolean
  readonly missingAuthProviders: readonly ProviderId[] | undefined
}

export interface StartupAuthState {
  readonly initialAgent: AgentName | undefined
  readonly missingProviders: readonly ProviderId[]
}

export interface InteractiveBootstrapResult {
  readonly bootstrap: AppBootstrap
  readonly initialAgent: AgentName | undefined
}

export const toSession = (session: SessionInfo): Session | undefined => {
  if (session.branchId === undefined) return undefined
  return {
    sessionId: session.id,
    branchId: session.branchId,
    name: session.name ?? "Unnamed",
    reasoningLevel: session.reasoningLevel,
  }
}

const toSessionInfo = (
  result: { sessionId: SessionId; branchId: BranchId; name: string },
  cwd: string,
): SessionInfo => ({
  id: result.sessionId,
  name: result.name,
  cwd,
  reasoningLevel: undefined,
  branchId: result.branchId,
  parentSessionId: undefined,
  parentBranchId: undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

export const resolveAppBootstrap = (
  state: Exclude<InitialState, { _tag: "headless" }>,
  options: {
    missingProviders: readonly ProviderId[]
    debugMode: boolean
  },
): AppBootstrap => {
  const missingAuthProviders =
    options.missingProviders.length > 0 ? options.missingProviders : undefined

  switch (state._tag) {
    case "session": {
      // branchId is always present for sessions created by resolveInitialState.
      // Guard for corrupt session records from -s <id> with missing branch.
      if (state.session.branchId === undefined) {
        throw new Error(`Session ${state.session.id} has no branch — cannot render`)
      }
      return {
        initialSession: toSession(state.session),
        initialRoute: Route.session(state.session.id, state.session.branchId, state.prompt),
        debugMode: options.debugMode,
        missingAuthProviders,
      }
    }
    case "branchPicker":
      return {
        initialSession: undefined,
        initialRoute: Route.branchPicker(
          state.session.id,
          state.session.name ?? "Unnamed",
          state.branches,
          state.prompt,
        ),
        debugMode: options.debugMode,
        missingAuthProviders,
      }
  }
}

export const resolveInteractiveBootstrap = (input: {
  client: Pick<GentNamespacedClient, "auth" | "branch" | "session">
  cwd: string
  sessionId?: string
  continue_: boolean
  prompt?: string
  debugMode: boolean
}): Effect.Effect<InteractiveBootstrapResult, GentRpcError> =>
  Effect.gen(function* () {
    const state = yield* resolveInitialState({
      client: input.client,
      cwd: input.cwd,
      session: input.sessionId !== undefined ? Option.some(input.sessionId) : Option.none(),
      continue_: input.continue_,
      headless: false,
      prompt: input.prompt !== undefined ? Option.some(input.prompt) : Option.none(),
      promptArg: Option.none(),
    })

    if (state._tag === "headless") {
      return yield* Effect.die("interactive bootstrap resolved a headless state")
    }

    const startupAuth = yield* resolveStartupAuthState({
      client: input.client,
      state,
    })

    return {
      bootstrap: resolveAppBootstrap(state, {
        missingProviders: startupAuth.missingProviders,
        debugMode: input.debugMode,
      }),
      initialAgent: startupAuth.initialAgent,
    }
  })

const resolveSessionRuntimeAgent = (
  client: Pick<GentNamespacedClient, "session">,
  session: SessionInfo,
): Effect.Effect<AgentName | undefined, GentRpcError> => {
  if (session.branchId === undefined) return Effect.void.pipe(Effect.as(undefined))
  return client.session
    .getSnapshot({
      sessionId: session.id,
      branchId: session.branchId,
    })
    .pipe(Effect.map((snapshot) => snapshot.runtime.agent))
}

export const resolveStartupAuthState = (input: {
  client: Pick<GentNamespacedClient, "auth" | "session">
  state: InitialState
  requestedAgent?: AgentName
}): Effect.Effect<StartupAuthState, GentRpcError> =>
  Effect.gen(function* () {
    if (input.state._tag === "branchPicker") {
      return {
        initialAgent: undefined,
        missingProviders: [],
      }
    }

    const sessionAgent =
      input.state._tag === "session" || input.state._tag === "headless"
        ? yield* resolveSessionRuntimeAgent(input.client, input.state.session)
        : undefined

    const authAgent =
      input.state._tag === "headless" ? (input.requestedAgent ?? sessionAgent) : sessionAgent

    // Thread sessionId so per-session cwd resolves project-level
    // driverOverrides (counsel HIGH #2). Branch-picker has no session.
    const sessionIdForAuth =
      input.state._tag === "session" || input.state._tag === "headless"
        ? input.state.session.id
        : undefined
    const providers = yield* input.client.auth.listProviders({
      ...(authAgent !== undefined ? { agentName: authAgent } : {}),
      ...(sessionIdForAuth !== undefined ? { sessionId: sessionIdForAuth } : {}),
    })

    return {
      initialAgent: input.state._tag === "headless" ? undefined : authAgent,
      missingProviders: providers
        .filter((provider) => provider.required && !provider.hasKey)
        .map((provider) => provider.provider),
    }
  })

export const resolveInitialState = (input: {
  client: Pick<GentNamespacedClient, "session" | "branch">
  cwd: string
  session: Option.Option<string>
  continue_: boolean
  headless: boolean
  prompt: Option.Option<string>
  promptArg: Option.Option<string>
}): Effect.Effect<InitialState, GentRpcError> =>
  Effect.gen(function* () {
    const { client, cwd, session, continue_, headless, prompt, promptArg } = input

    if (headless) {
      const promptText = Option.isSome(promptArg) ? promptArg.value : undefined
      if (promptText === undefined || promptText.length === 0) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return yield* Effect.die("fatal")
      }
      if (Option.isSome(session)) {
        const sess = yield* client.session.get({ sessionId: SessionId.of(session.value) })
        if (sess === null) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return yield* Effect.die("fatal")
        }
        return { _tag: "headless" as const, session: sess, prompt: promptText }
      }

      const result = yield* client.session.create({ cwd })
      return { _tag: "headless" as const, session: toSessionInfo(result, cwd), prompt: promptText }
    }

    if (Option.isSome(session)) {
      const sess = yield* client.session.get({ sessionId: SessionId.of(session.value) })
      if (sess === null) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return yield* Effect.die("fatal")
      }
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* client.branch.list({ sessionId: sess.id })
      if (branches.length > 1) {
        return {
          _tag: "branchPicker" as const,
          session: sess,
          branches,
          prompt: promptText,
        }
      }
      return { _tag: "session" as const, session: sess, prompt: promptText }
    }

    if (continue_) {
      const existing = yield* client.session
        .list()
        .pipe(
          Effect.map(
            (sessions) =>
              sessions
                .filter((candidate) => candidate.cwd === cwd)
                .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null,
          ),
        )
      if (existing !== null) {
        const promptText = Option.getOrUndefined(prompt)
        const branches = yield* client.branch.list({ sessionId: existing.id })
        if (branches.length > 1) {
          return {
            _tag: "branchPicker" as const,
            session: existing,
            branches,
            prompt: promptText,
          }
        }
        return { _tag: "session" as const, session: existing, prompt: promptText }
      }
      // No existing session for cwd — fall through to create one
    }

    const promptText = Option.getOrUndefined(prompt)
    const result = yield* client.session.create({ cwd })
    return { _tag: "session" as const, session: toSessionInfo(result, cwd), prompt: promptText }
  })
