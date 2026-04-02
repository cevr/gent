import { Console, Effect, Option } from "effect"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
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
        const sess = yield* client.session.get({ sessionId: session.value as SessionId })
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
      const sess = yield* client.session.get({ sessionId: session.value as SessionId })
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
