import { Console, Effect, Option } from "effect"
import type { SessionId } from "@gent/core/domain/ids.js"
import type { ProviderId } from "@gent/core/domain/model.js"
import type { GentClient, GentRpcError, BranchInfo, SessionInfo } from "@gent/sdk"
import type { Session } from "./client/index"
import { Route } from "./router/index"

export type InitialState =
  | { _tag: "home" }
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
  readonly initialRoute: ReturnType<typeof Route.home>
  readonly initialPrompt: string | undefined
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

export const resolveAppBootstrap = (
  state: Exclude<InitialState, { _tag: "headless" | "debug" }>,
  options: {
    missingProviders: readonly ProviderId[]
    debugMode: boolean
  },
): AppBootstrap => {
  const missingAuthProviders =
    options.missingProviders.length > 0 ? options.missingProviders : undefined

  switch (state._tag) {
    case "home":
      return {
        initialSession: undefined,
        initialRoute: Route.home(),
        initialPrompt: undefined,
        debugMode: options.debugMode,
        missingAuthProviders,
      }
    case "session":
      return {
        initialSession: toSession(state.session),
        initialRoute:
          state.session.branchId !== undefined
            ? Route.session(state.session.id, state.session.branchId)
            : Route.home(),
        initialPrompt: state.prompt,
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
        initialPrompt: undefined,
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
      const sess: SessionInfo = {
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
      }
      return { _tag: "headless" as const, session: sess, prompt: promptText }
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
      const result = yield* Effect.gen(function* () {
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
          return { session: existing, createdFromPrompt: false as const }
        }

        const firstMessage = Option.getOrUndefined(prompt)
        const created = yield* client.createSession({
          cwd,
          bypass,
          ...(firstMessage !== undefined ? { firstMessage } : {}),
        })
        return {
          session: {
            id: created.sessionId,
            name: created.name,
            cwd,
            bypass: created.bypass,
            reasoningLevel: undefined,
            branchId: created.branchId,
            parentSessionId: undefined,
            parentBranchId: undefined,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          } satisfies SessionInfo,
          createdFromPrompt: firstMessage !== undefined,
        }
      })
      const sess = result.session
      const promptText = result.createdFromPrompt ? undefined : Option.getOrUndefined(prompt)
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

    if (Option.isSome(prompt)) {
      const result = yield* client.createSession({
        cwd,
        bypass,
        firstMessage: prompt.value,
      })
      const sess: SessionInfo = {
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
      }
      return { _tag: "session" as const, session: sess }
    }

    return { _tag: "home" as const }
  })
