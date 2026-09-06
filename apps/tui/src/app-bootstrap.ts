import { Console, Effect, Match, Option, Predicate, Schema } from "effect"
import { DEFAULT_AGENT_NAME, type AgentName } from "@gent/core-internal/domain/agent.js"
import { SessionId } from "@gent/core-internal/domain/ids.js"
import type { ProviderId } from "@gent/core-internal/domain/model.js"
import type {
  GentNamespacedClient,
  GentClientRpcError,
  Branch,
  Session as DomainSession,
} from "@gent/sdk"
import type { Session as ClientSession } from "./client/index"
import { Route } from "./router"
import type { AppRoute } from "./router"
import { randomId } from "./utils/random-id"

/**
 * Surfaces a corrupt session record (session row exists but has no
 * `activeBranchId`). Caught at the bootstrap boundary in `main.tsx`
 * so the user sees a structured error message instead of a stack
 * trace. Thrown synchronously because `resolveAppBootstrap` is a
 * synchronous projection at the render boundary.
 */
export class AppBootstrapError extends Schema.TaggedError<AppBootstrapError>()(
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
    const sessionLabel = Option.getOrElse(Option.fromNullishOr(this.sessionId), () => "unknown")
    switch (this.reason) {
      case "created-session-unreadable":
        return `Created session ${sessionLabel} was not readable`
      case "interactive-headless-state":
        return "Interactive bootstrap resolved a headless state"
      case "headless-missing-prompt":
        return "Headless startup requires a prompt argument"
      case "missing-branch":
        return `Session ${sessionLabel} has no branch — cannot render`
      case "session-not-found":
        return `Session ${sessionLabel} not found`
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
  // eslint-disable-next-line effect/noNullish -- bootstrap API uses absence when no session is selected.
  readonly initialSession: ClientSession | undefined
  readonly initialRoute: AppRoute
  readonly debugMode: boolean
  // eslint-disable-next-line effect/noNullish -- bootstrap API uses absence when all providers are configured.
  readonly missingAuthProviders: readonly ProviderId[] | undefined
}

export interface StartupAuthState {
  // eslint-disable-next-line effect/noNullish -- auth API uses absence when no agent override is needed.
  readonly initialAgent: AgentName | undefined
  readonly missingProviders: readonly ProviderId[]
}

export interface InteractiveBootstrapResult {
  readonly bootstrap: AppBootstrap
  // eslint-disable-next-line effect/noNullish -- bootstrap API uses absence for headless startup.
  readonly initialAgent: AgentName | undefined
}

// eslint-disable-next-line effect/noNullish -- bootstrap projection returns absence for an unreadable branch.
export const toSession = (session: DomainSession): ClientSession | undefined => {
  const branchId = Option.fromNullishOr(session.activeBranchId)
  if (Option.isNone(branchId)) return Option.getOrUndefined(Option.none<ClientSession>())
  return {
    sessionId: session.id,
    branchId: branchId.value,
    name: Option.getOrElse(Option.fromNullishOr(session.name), () => "Unnamed"),
    reasoningLevel: session.reasoningLevel,
  }
}

const createAndLoadSession = (input: {
  client: Pick<GentNamespacedClient, "session">
  cwd: string
}): Effect.Effect<DomainSession, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const requestId = yield* randomId
    const result = yield* input.client.session.create({
      cwd: input.cwd,
      requestId,
    })
    const session = yield* input.client.session.get({ sessionId: result.sessionId })
    const decodedSession = Option.fromNullishOr(session)
    if (Option.isNone(decodedSession)) {
      return yield* new AppBootstrapError({
        sessionId: result.sessionId,
        reason: "created-session-unreadable",
      })
    }
    return decodedSession.value
  })

export const resolveAppBootstrap = (
  state: Exclude<InitialState, { _tag: "headless" }>,
  options: {
    missingProviders: readonly ProviderId[]
    debugMode: boolean
  },
): AppBootstrap => {
  let missingAuthProviders = Option.none<readonly ProviderId[]>()
  if (options.missingProviders.length > 0) {
    missingAuthProviders = Option.some(options.missingProviders)
  }

  return Match.value(state).pipe(
    Match.tagsExhaustive({
      session: (state) => {
        // activeBranchId is always present for sessions created by resolveInitialState.
        // Guard for corrupt session records from -s <id> with missing branch.
        const branchId = Option.fromNullishOr(state.session.activeBranchId)
        if (Option.isNone(branchId)) {
          // eslint-disable-next-line effect/noThrowStatement -- synchronous render-boundary validation must throw.
          throw new AppBootstrapError({ sessionId: state.session.id, reason: "missing-branch" })
        }
        return {
          initialSession: toSession(state.session),
          initialRoute: Route.session(state.session.id, branchId.value, state.prompt),
          debugMode: options.debugMode,
          missingAuthProviders: Option.getOrUndefined(missingAuthProviders),
        }
      },
      branchPicker: (state) => ({
        initialSession: Option.getOrUndefined(Option.none<ClientSession>()),
        initialRoute: Route.branchPicker(
          state.session.id,
          Option.getOrElse(Option.fromNullishOr(state.session.name), () => "Unnamed"),
          state.branches,
          state.prompt,
        ),
        debugMode: options.debugMode,
        missingAuthProviders: Option.getOrUndefined(missingAuthProviders),
      }),
    }),
  )
}

export const resolveInteractiveBootstrap = (input: {
  client: Pick<GentNamespacedClient, "auth" | "branch" | "session">
  cwd: string
  sessionId?: string
  continue_: boolean
  prompt?: string
  debugMode: boolean
}): Effect.Effect<InteractiveBootstrapResult, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const state = yield* resolveInitialState({
      client: input.client,
      cwd: input.cwd,
      session: Option.fromNullishOr(input.sessionId),
      continue_: input.continue_,
      headless: false,
      prompt: Option.fromNullishOr(input.prompt),
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
): Effect.Effect<Option.Option<AgentName>, GentClientRpcError> => {
  const branchId = Option.fromNullishOr(session.activeBranchId)
  if (Option.isNone(branchId)) return Effect.succeedNone
  return client.session
    .getSnapshot({
      sessionId: session.id,
      branchId: branchId.value,
    })
    .pipe(Effect.map((snapshot) => Option.fromNullishOr(snapshot.runtime.agent)))
}

export const resolveStartupAuthState = (input: {
  client: Pick<GentNamespacedClient, "auth" | "session">
  state: InitialState
  requestedAgent?: AgentName
}): Effect.Effect<StartupAuthState, GentClientRpcError> =>
  Effect.gen(function* () {
    if (input.state._tag === "branchPicker") {
      return {
        initialAgent: Option.getOrUndefined(Option.none<AgentName>()),
        missingProviders: [],
      }
    }

    const hasSession = Predicate.or(Predicate.isTagged("session"), Predicate.isTagged("headless"))
    let sessionAgent = Option.none<AgentName>()
    if (hasSession(input.state)) {
      sessionAgent = yield* resolveSessionRuntimeAgent(input.client, input.state.session)
    }

    const requestedAgent = Option.fromNullishOr(input.requestedAgent)
    let candidateAgent = requestedAgent
    if (input.state._tag === "headless") {
      candidateAgent = Option.orElse(requestedAgent, () => sessionAgent)
    } else {
      candidateAgent = Option.orElse(sessionAgent, () => requestedAgent)
    }
    const authAgent = Option.getOrElse(candidateAgent, () => DEFAULT_AGENT_NAME)

    // Thread sessionId so per-session cwd resolves project-level
    // driverOverrides (counsel HIGH #2). Branch-picker has no session.
    let sessionIdForAuth = Option.none<SessionId>()
    if (hasSession(input.state)) sessionIdForAuth = Option.some(input.state.session.id)
    const providers = yield* input.client.auth.listProviders({
      agentName: authAgent,
      sessionId: Option.getOrUndefined(sessionIdForAuth),
    })

    let initialAgent = Option.some(authAgent)
    if (input.state._tag === "headless") initialAgent = Option.none()
    return {
      initialAgent: Option.getOrUndefined(initialAgent),
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
}): Effect.Effect<InitialState, GentClientRpcError | AppBootstrapError> =>
  Effect.gen(function* () {
    const { client, cwd, session, continue_, headless, prompt, promptArg } = input

    if (headless) {
      if (Option.isNone(promptArg) || promptArg.value.length === 0) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return yield* new AppBootstrapError({ reason: "headless-missing-prompt" })
      }
      if (Option.isSome(session)) {
        const sessionId = SessionId.make(session.value)
        const sess = yield* client.session.get({ sessionId })
        const decodedSession = Option.fromNullishOr(sess)
        if (Option.isNone(decodedSession)) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return yield* new AppBootstrapError({ sessionId, reason: "session-not-found" })
        }
        return {
          _tag: "headless",
          session: decodedSession.value,
          prompt: promptArg.value,
        } satisfies InitialState
      }

      const created = yield* createAndLoadSession({ client, cwd })
      return {
        _tag: "headless",
        session: created,
        prompt: promptArg.value,
      } satisfies InitialState
    }

    if (Option.isSome(session)) {
      const sessionId = SessionId.make(session.value)
      const sess = yield* client.session.get({ sessionId })
      const decodedSession = Option.fromNullishOr(sess)
      if (Option.isNone(decodedSession)) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return yield* new AppBootstrapError({ sessionId, reason: "session-not-found" })
      }
      const promptText = Option.getOrUndefined(prompt)
      const branches = yield* client.branch.list({ sessionId: decodedSession.value.id })
      if (branches.length > 1) {
        return {
          _tag: "branchPicker",
          session: decodedSession.value,
          branches,
          prompt: promptText,
        } satisfies InitialState
      }
      return {
        _tag: "session",
        session: decodedSession.value,
        prompt: promptText,
      } satisfies InitialState
    }

    if (continue_) {
      const existing = yield* client.session
        .list()
        .pipe(
          Effect.map((sessions) =>
            Option.fromNullishOr(
              sessions
                .filter((candidate) => candidate.cwd === cwd)
                .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0],
            ),
          ),
        )
      if (Option.isSome(existing)) {
        const existingSession = existing.value
        const promptText = Option.getOrUndefined(prompt)
        const branches = yield* client.branch.list({ sessionId: existingSession.id })
        if (branches.length > 1) {
          return {
            _tag: "branchPicker",
            session: existingSession,
            branches,
            prompt: promptText,
          } satisfies InitialState
        }
        return {
          _tag: "session",
          session: existingSession,
          prompt: promptText,
        } satisfies InitialState
      }
      // No existing session for cwd — fall through to create one
    }

    const promptText = Option.getOrUndefined(prompt)
    const created = yield* createAndLoadSession({ client, cwd })
    return { _tag: "session", session: created, prompt: promptText } satisfies InitialState
  })
