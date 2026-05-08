import type { BranchId, SessionId } from "@gent/core-internal/domain/ids.js"
import { createContext, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import type { Branch } from "../client"

export type AppRoute =
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
      readonly branches: readonly Branch[]
      readonly prompt?: string
    }

export interface AppRouterState {
  readonly current: AppRoute
  readonly history: readonly AppRoute[]
}

export const Route = {
  session: (sessionId: SessionId, branchId: BranchId, prompt?: string): AppRoute => ({
    _tag: "session",
    sessionId,
    branchId,
    ...(prompt !== undefined ? { prompt } : {}),
  }),
  branchPicker: (
    sessionId: SessionId,
    sessionName: string,
    branches: readonly Branch[],
    prompt?: string,
  ): AppRoute => ({
    _tag: "branchPicker",
    sessionId,
    sessionName,
    branches,
    ...(prompt !== undefined ? { prompt } : {}),
  }),
}

export const isRoute = {
  session: (r: AppRoute): r is Extract<AppRoute, { _tag: "session" }> => r._tag === "session",
  branchPicker: (r: AppRoute): r is Extract<AppRoute, { _tag: "branchPicker" }> =>
    r._tag === "branchPicker",
}

export type RouterAction =
  | { readonly type: "navigate"; readonly route: AppRoute }
  | { readonly type: "back" }

export function routerReducer(state: AppRouterState, action: RouterAction): AppRouterState {
  switch (action.type) {
    case "navigate": {
      if (state.current._tag === action.route._tag) {
        return { ...state, current: action.route }
      }
      return {
        current: action.route,
        history: [...state.history, state.current],
      }
    }
    case "back": {
      if (state.history.length === 0) return state
      const newHistory = [...state.history]
      const previous = newHistory.pop()
      if (previous === undefined) return state
      return { current: previous, history: newHistory }
    }
  }
}

export type RouterSubscriber = (state: AppRouterState) => void

export interface AppRouter {
  getState: () => AppRouterState
  navigate: (route: AppRoute) => void
  back: () => boolean
  canGoBack: () => boolean
  subscribe: (subscriber: RouterSubscriber) => () => void
}

export function createAppRouter(initialState: AppRouterState): AppRouter {
  let state = initialState
  const subscribers = new Set<RouterSubscriber>()

  const notify = () => {
    for (const sub of subscribers) {
      sub(state)
    }
  }

  return {
    getState: () => state,

    navigate: (route: AppRoute) => {
      state = routerReducer(state, { type: "navigate", route })
      notify()
    },

    back: () => {
      if (state.history.length === 0) return false
      state = routerReducer(state, { type: "back" })
      notify()
      return true
    },

    canGoBack: () => state.history.length > 0,

    subscribe: (subscriber: RouterSubscriber) => {
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
  }
}

export interface RouterContextValue {
  route: () => AppRoute
  navigate: (route: AppRoute) => void
  navigateToSession: (sessionId: SessionId, branchId: BranchId, prompt?: string) => void
  navigateToBranchPicker: (
    sessionId: SessionId,
    sessionName: string,
    branches: readonly Branch[],
    prompt?: string,
  ) => void
  back: () => boolean
  canGoBack: () => boolean
}

const RouterContext = createContext<RouterContextValue>()

export interface RouterProviderProps {
  initialRoute: AppRoute
}

export function RouterProvider(props: ParentProps<RouterProviderProps>) {
  const router: AppRouter = createAppRouter({
    current: props.initialRoute,
    history: [],
  })

  const [route, setRoute] = createSignal<AppRoute>(router.getState().current)

  onCleanup(
    router.subscribe((state) => {
      setRoute(state.current)
    }),
  )

  const value: RouterContextValue = {
    route,
    navigate: router.navigate,
    navigateToSession: (sessionId: SessionId, branchId: BranchId, prompt?: string) =>
      router.navigate(Route.session(sessionId, branchId, prompt)),
    navigateToBranchPicker: (sessionId, sessionName, branches, prompt) =>
      router.navigate(Route.branchPicker(sessionId, sessionName, branches, prompt)),
    back: router.back,
    canGoBack: router.canGoBack,
  }

  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>
}

export function useRouter(): RouterContextValue {
  const ctx = useContext(RouterContext)
  if (ctx === undefined) {
    throw new Error("useRouter must be used within RouterProvider")
  }
  return ctx
}

export function useRoute(): () => AppRoute {
  return useRouter().route
}
