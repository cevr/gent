import { Effect } from "effect"
import { prepareDebugSession } from "@gent/core/debug/session.js"
import type { ProviderId } from "@gent/core/domain/model.js"
import type { BranchInfo, SessionInfo } from "@gent/sdk"
import type { Session } from "./client/index"
import { Route } from "./router/index"

export type InitialState =
  | { _tag: "home" }
  | { _tag: "debug" }
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

const toSession = (session: SessionInfo): Session | undefined => {
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
  state: Exclude<InitialState, { _tag: "headless" }>,
  options: {
    cwd: string
    debug: boolean
    missingProviders: readonly ProviderId[]
  },
) =>
  Effect.gen(function* () {
    const missingAuthProviders =
      !options.debug && options.missingProviders.length > 0 ? options.missingProviders : undefined

    switch (state._tag) {
      case "home":
        return {
          initialSession: undefined,
          initialRoute: Route.home(),
          initialPrompt: undefined,
          debugMode: false,
          missingAuthProviders,
        } satisfies AppBootstrap
      case "debug": {
        const debugSession = yield* prepareDebugSession(options.cwd)
        return {
          initialSession: debugSession,
          initialRoute: Route.session(debugSession.sessionId, debugSession.branchId),
          initialPrompt: undefined,
          debugMode: true,
          missingAuthProviders,
        } satisfies AppBootstrap
      }
      case "session":
        return {
          initialSession: toSession(state.session),
          initialRoute:
            state.session.branchId !== undefined
              ? Route.session(state.session.id, state.session.branchId)
              : Route.home(),
          initialPrompt: state.prompt,
          debugMode: false,
          missingAuthProviders,
        } satisfies AppBootstrap
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
          debugMode: false,
          missingAuthProviders,
        } satisfies AppBootstrap
    }
  })
