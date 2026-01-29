/**
 * Router context + provider for Solid
 */

import { createContext, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import { type AppRoute, Route } from "./types"
import type { BranchInfo } from "../client"
import { createAppRouter, type AppRouter } from "./router"

export interface RouterContextValue {
  route: () => AppRoute
  navigate: (route: AppRoute) => void
  navigateToHome: () => void
  navigateToSession: (sessionId: string, branchId: string, prompt?: string) => void
  navigateToBranchPicker: (
    sessionId: string,
    sessionName: string,
    branches: readonly BranchInfo[],
    prompt?: string,
  ) => void
  navigateToPermissions: () => void
  navigateToAuth: () => void
  back: () => boolean
  canGoBack: () => boolean
}

const RouterContext = createContext<RouterContextValue>()

export interface RouterProviderProps {
  initialRoute?: AppRoute
}

export function RouterProvider(props: ParentProps<RouterProviderProps>) {
  const initial = props.initialRoute ?? Route.home()

  const router: AppRouter = createAppRouter({
    current: initial,
    history: [],
  })

  const [route, setRoute] = createSignal<AppRoute>(router.getState().current)

  // Subscribe to router state changes
  onCleanup(
    router.subscribe((state) => {
      setRoute(state.current)
    }),
  )

  const value: RouterContextValue = {
    route,
    navigate: router.navigate,
    navigateToHome: () => router.navigate(Route.home()),
    navigateToSession: (sessionId: string, branchId: string, prompt?: string) =>
      router.navigate(Route.session(sessionId, branchId, prompt)),
    navigateToBranchPicker: (sessionId, sessionName, branches, prompt) =>
      router.navigate(Route.branchPicker(sessionId, sessionName, branches, prompt)),
    navigateToPermissions: () => router.navigate(Route.permissions()),
    navigateToAuth: () => router.navigate(Route.auth()),
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
