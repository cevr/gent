/**
 * Route discriminated union and helpers
 */

import type { BranchId, SessionId } from "@gent/core"
import type { BranchInfo } from "../client"

export type AppRoute =
  | { readonly _tag: "home" }
  | {
      readonly _tag: "session"
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly prompt?: string
    }
  | {
      readonly _tag: "branchPicker"
      readonly sessionId: SessionId
      readonly sessionName: string
      readonly branches: readonly BranchInfo[]
      readonly prompt?: string
    }
  | { readonly _tag: "permissions" }
  | { readonly _tag: "auth" }

export interface AppRouterState {
  readonly current: AppRoute
  readonly history: readonly AppRoute[]
}

// Constructors
export const Route = {
  home: (): AppRoute => ({ _tag: "home" }),
  session: (sessionId: SessionId, branchId: BranchId, prompt?: string): AppRoute => ({
    _tag: "session",
    sessionId,
    branchId,
    ...(prompt !== undefined ? { prompt } : {}),
  }),
  branchPicker: (
    sessionId: SessionId,
    sessionName: string,
    branches: readonly BranchInfo[],
    prompt?: string,
  ): AppRoute => ({
    _tag: "branchPicker",
    sessionId,
    sessionName,
    branches,
    ...(prompt !== undefined ? { prompt } : {}),
  }),
  permissions: (): AppRoute => ({ _tag: "permissions" }),
  auth: (): AppRoute => ({ _tag: "auth" }),
}

// Type guards
export const isRoute = {
  home: (r: AppRoute): r is Extract<AppRoute, { _tag: "home" }> => r._tag === "home",
  session: (r: AppRoute): r is Extract<AppRoute, { _tag: "session" }> => r._tag === "session",
  branchPicker: (r: AppRoute): r is Extract<AppRoute, { _tag: "branchPicker" }> =>
    r._tag === "branchPicker",
  permissions: (r: AppRoute): r is Extract<AppRoute, { _tag: "permissions" }> =>
    r._tag === "permissions",
  auth: (r: AppRoute): r is Extract<AppRoute, { _tag: "auth" }> => r._tag === "auth",
}
