import { Console, Effect, Option } from "effect"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { ProviderId } from "@gent/core/domain/model.js"
import type { GentClient, GentRpcError, BranchInfo, SessionInfo } from "@gent/sdk"
import type { Session } from "./client/index"
import { Route } from "./router/index"
import type { AppRoute } from "./router/index"

export type InitialState =
  | { _tag: "auth" }
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
    bypass: session.bypass ?? true,
    reasoningLevel: session.reasoningLevel,
  }
}

const toSessionInfo = (
  result: { sessionId: SessionId; branchId: BranchId; name: string; bypass: boolean },
  cwd: string,
): SessionInfo => ({
  id: result.sessionId,
  name: result.name,
  cwd,
  bypass: result.bypass,
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
    case "auth":
      return {
        initialSession: undefined,
        initialRoute: Route.auth(),
        debugMode: options.debugMode,
        missingAuthProviders,
      }
    case "session":
      return {
        initialSession: toSession(state.session),
        initialRoute:
          state.session.branchId !== undefined
            ? Route.session(state.session.id, state.session.branchId, state.prompt)
            : Route.auth(),
        debugMode: options.debugMode,
        missingAuthProviders,
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
  client: Pick<GentClient, "getSession" | "createSession" | "listBranches" | "listSessions">
  cwd: string
  session: Option.Option<string>
  continue_: boolean
  headless: boolean
  prompt: Option.Option<string>
  promptArg: Option.Option<string>
  bypass: boolean
  missingProviders: readonly string[]
}): Effect.Effect<InitialState, GentRpcError> =>
  Effect.gen(function* () {
    const { client, cwd, session, continue_, headless, prompt, promptArg, bypass } = input

    if (headless) {
      const promptText = Option.isSome(promptArg) ? promptArg.value : undefined
      if (promptText === undefined || promptText.length === 0) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return process.exit(1)
      }
      if (Option.isSome(session)) {
        const sess = yield* client.getSession(session.value as SessionId)
        if (sess === null) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return process.exit(1)
        }
        return { _tag: "headless" as const, session: sess, prompt: promptText }
      }

      const result = yield* client.createSession({ cwd, bypass })
      return { _tag: "headless" as const, session: toSessionInfo(result, cwd), prompt: promptText }
    }

    if (Option.isSome(session)) {
      const sess = yield* client.getSession(session.value as SessionId)
      if (sess === null) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return process.exit(1)
      }
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* client.listBranches(sess.id)
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
      const existing = yield* client
        .listSessions()
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
        const branches = yield* client.listBranches(existing.id)
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

    // Gate: don't create a session if auth is required
    if (input.missingProviders.length > 0) {
      return { _tag: "auth" as const }
    }

    const promptText = Option.getOrUndefined(prompt)
    const result = yield* client.createSession({ cwd, bypass })
    return { _tag: "session" as const, session: toSessionInfo(result, cwd), prompt: promptText }
  })
