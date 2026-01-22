/**
 * Route discriminated union and helpers
 */

export type AppRoute =
  | { readonly _tag: "home" }
  | {
      readonly _tag: "session"
      readonly sessionId: string
      readonly branchId: string
      readonly prompt?: string
    }

export interface AppRouterState {
  readonly current: AppRoute
  readonly history: readonly AppRoute[]
}

// Constructors
export const Route = {
  home: (): AppRoute => ({ _tag: "home" }),
  session: (sessionId: string, branchId: string, prompt?: string): AppRoute => ({
    _tag: "session",
    sessionId,
    branchId,
    ...(prompt !== undefined ? { prompt } : {}),
  }),
}

// Type guards
export const isRoute = {
  home: (r: AppRoute): r is Extract<AppRoute, { _tag: "home" }> => r._tag === "home",
  session: (r: AppRoute): r is Extract<AppRoute, { _tag: "session" }> => r._tag === "session",
}
