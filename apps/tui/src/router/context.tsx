/**
 * Router context + provider for Solid
 */

import { createContext, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import { type AppRoute, Route } from "./types.js"
import { createAppRouter, type AppRouter } from "./router.js"

export interface RouterContextValue {
  route: () => AppRoute
  navigate: (route: AppRoute) => void
  navigateToHome: () => void
  navigateToSession: (sessionId: string, branchId: string) => void
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
    navigateToSession: (sessionId: string, branchId: string) =>
      router.navigate(Route.session(sessionId, branchId)),
    back: router.back,
    canGoBack: router.canGoBack,
  }

  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>
}

export function useRouter(): RouterContextValue {
  const ctx = useContext(RouterContext)
  if (!ctx) {
    throw new Error("useRouter must be used within RouterProvider")
  }
  return ctx
}

export function useRoute(): () => AppRoute {
  return useRouter().route
}
