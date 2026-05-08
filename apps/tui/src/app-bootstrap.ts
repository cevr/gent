import { Console, Effect, Option, Random, Schema } from "effect"
import { DEFAULT_AGENT_NAME, type AgentName } from "@gent/core-internal/domain/agent.js"
import { SessionId } from "@gent/core-internal/domain/ids.js"
import type { ProviderId } from "@gent/core-internal/domain/model.js"
import type {
  GentNamespacedClient,
  GentRpcError,
  Branch,
  Session as DomainSession,
} from "@gent/sdk"
import type { Session as ClientSession } from "./client/index"
import { Route } from "./router/index"
import type { AppRoute } from "./router/index"

/**
 * Surfaces a corrupt session record (session row exists but has no
 * `activeBranchId`). Caught at the bootstrap boundary in `main.tsx`
 * so the user sees a structured error message instead of a stack
 * trace. Thrown synchronously because `resolveAppBootstrap` is a
 * synchronous projection at the render boundary.
 */
export class AppBootstrapError extends Schema.TaggedErrorClass<AppBootstrapError>()(
  "AppBootstrapError",
  {
    sessionId: Schema.optional(SessionId),
    reason: Schema.Literals([
      "created-session-unreadable",
      "interactive-headless-state",
      "headless-missing-prompt",
      "missing-branch",
      "session-not-found",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "created-session-unreadable":
        return `Created session ${this.sessionId ?? "unknown"} was not readable`
      case "interactive-headless-state":
        return "Interactive bootstrap resolved a headless state"
      case "headless-missing-prompt":
        return "Headless startup requires a prompt argument"
      case "missing-branch":
        return `Session ${this.sessionId ?? "unknown"} has no branch — cannot render`
      case "session-not-found":
        return `Session ${this.sessionId ?? "unknown"} not found`
    }
  }
}

export type InitialState =
  | { _tag: "session"; session: DomainSession; prompt?: string }
  | {
      _tag: "branchPicker"
      session: DomainSession
      branches: readonly Branch[]
      prompt?: string
    }
  | { _tag: "headless"; session: DomainSession; prompt: string }

export interface AppBootstrap {
  readonly initialSession: ClientSession | undefined
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

export const toSession = (session: DomainSession): ClientSession | undefined => {
  if (session.activeBranchId === undefined) return undefined
  return {
    sessionId: session.id,
    branchId: session.activeBranchId,
    name: session.name ?? "Unnamed",
    reasoningLevel: session.reasoningLevel,
  }
}

const createAndLoadSession = (input: {
  client: Pick<GentNamespacedClient, "session">
  cwd: string
}): Effect.Effect<DomainSession, GentRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const requestId = yield* Random.nextUUIDv4
    const result = yield* input.client.session.create({
      cwd: input.cwd,
      requestId,
    })
    const session = yield* input.client.session.get({ sessionId: result.sessionId })
    if (session === null) {
      return yield* new AppBootstrapError({
        sessionId: result.sessionId,
        reason: "created-session-unreadable",
      })
    }
    return session
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
      // activeBranchId is always present for sessions created by resolveInitialState.
      // Guard for corrupt session records from -s <id> with missing branch.
      if (state.session.activeBranchId === undefined) {
        throw new AppBootstrapError({ sessionId: state.session.id, reason: "missing-branch" })
      }
      return {
        initialSession: toSession(state.session),
        initialRoute: Route.session(state.session.id, state.session.activeBranchId, state.prompt),
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
}): Effect.Effect<InteractiveBootstrapResult, GentRpcError | AppBootstrapError> =>
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
      return yield* new AppBootstrapError({ reason: "interactive-headless-state" })
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
  session: DomainSession,
): Effect.Effect<AgentName | undefined, GentRpcError> => {
  if (session.activeBranchId === undefined) return Effect.void.pipe(Effect.as(undefined))
  return client.session
    .getSnapshot({
      sessionId: session.id,
      branchId: session.activeBranchId,
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
      input.state._tag === "headless"
        ? (input.requestedAgent ?? sessionAgent ?? DEFAULT_AGENT_NAME)
        : (sessionAgent ?? input.requestedAgent ?? DEFAULT_AGENT_NAME)

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
}): Effect.Effect<InitialState, GentRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const { client, cwd, session, continue_, headless, prompt, promptArg } = input

    if (headless) {
      const promptText = Option.isSome(promptArg) ? promptArg.value : undefined
      if (promptText === undefined || promptText.length === 0) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return yield* new AppBootstrapError({ reason: "headless-missing-prompt" })
      }
      if (Option.isSome(session)) {
        const sessionId = SessionId.make(session.value)
        const sess = yield* client.session.get({ sessionId })
        if (sess === null) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return yield* new AppBootstrapError({ sessionId, reason: "session-not-found" })
        }
        return { _tag: "headless" as const, session: sess, prompt: promptText }
      }

      const created = yield* createAndLoadSession({ client, cwd })
      return {
        _tag: "headless" as const,
        session: created,
        prompt: promptText,
      }
    }

    if (Option.isSome(session)) {
      const sessionId = SessionId.make(session.value)
      const sess = yield* client.session.get({ sessionId })
      if (sess === null) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return yield* new AppBootstrapError({ sessionId, reason: "session-not-found" })
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
                .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0] ??
              null,
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
    const created = yield* createAndLoadSession({ client, cwd })
    return { _tag: "session" as const, session: created, prompt: promptText }
  })
