import { describe, test, expect } from "bun:test"
import { routerReducer, createAppRouter, type RouterAction } from "../src/router/router"
import { Route, type AppRoute, type AppRouterState } from "../src/router/types"

describe("routerReducer", () => {
  const initialState: AppRouterState = {
    current: Route.home(),
    history: [],
  }

  test("navigate to different route type pushes to history", () => {
    const action: RouterAction = {
      type: "navigate",
      route: Route.session("s1", "b1"),
    }
    const next = routerReducer(initialState, action)

    expect(next.current).toEqual({ _tag: "session", sessionId: "s1", branchId: "b1" })
    expect(next.history).toEqual([{ _tag: "home" }])
  })

  test("navigate to same route type replaces without history", () => {
    const state: AppRouterState = {
      current: Route.session("s1", "b1"),
      history: [Route.home()],
    }
    const action: RouterAction = {
      type: "navigate",
      route: Route.session("s2", "b2"),
    }
    const next = routerReducer(state, action)

    expect(next.current).toEqual({ _tag: "session", sessionId: "s2", branchId: "b2" })
    expect(next.history).toEqual([{ _tag: "home" }]) // unchanged
  })

  test("back pops from history", () => {
    const state: AppRouterState = {
      current: Route.session("s1", "b1"),
      history: [Route.home()],
    }
    const next = routerReducer(state, { type: "back" })

    expect(next.current).toEqual({ _tag: "home" })
    expect(next.history).toEqual([])
  })

  test("back with empty history is no-op", () => {
    const state: AppRouterState = {
      current: Route.home(),
      history: [],
    }
    const next = routerReducer(state, { type: "back" })

    expect(next).toBe(state) // same reference
  })

  test("multiple navigations build history stack", () => {
    let state = initialState

    state = routerReducer(state, { type: "navigate", route: Route.session("s1", "b1") })
    expect(state.history.length).toBe(1)

    state = routerReducer(state, { type: "navigate", route: Route.home() })
    expect(state.history.length).toBe(2)

    state = routerReducer(state, { type: "navigate", route: Route.session("s2", "b2") })
    expect(state.history.length).toBe(3)
  })
})

describe("createAppRouter", () => {
  test("getState returns initial state", () => {
    const initial: AppRouterState = { current: Route.home(), history: [] }
    const router = createAppRouter(initial)

    expect(router.getState()).toEqual(initial)
  })

  test("navigate updates state and notifies subscribers", () => {
    const router = createAppRouter({ current: Route.home(), history: [] })
    const received: AppRouterState[] = []

    router.subscribe((state) => received.push(state))
    router.navigate(Route.session("s1", "b1"))

    expect(router.getState().current).toEqual({ _tag: "session", sessionId: "s1", branchId: "b1" })
    expect(received.length).toBe(1)
    expect(received[0]?.current).toEqual({ _tag: "session", sessionId: "s1", branchId: "b1" })
  })

  test("back returns true when history exists", () => {
    const router = createAppRouter({ current: Route.home(), history: [] })
    router.navigate(Route.session("s1", "b1"))

    expect(router.back()).toBe(true)
    expect(router.getState().current).toEqual({ _tag: "home" })
  })

  test("back returns false when no history", () => {
    const router = createAppRouter({ current: Route.home(), history: [] })

    expect(router.back()).toBe(false)
    expect(router.getState().current).toEqual({ _tag: "home" })
  })

  test("canGoBack reflects history state", () => {
    const router = createAppRouter({ current: Route.home(), history: [] })

    expect(router.canGoBack()).toBe(false)

    router.navigate(Route.session("s1", "b1"))
    expect(router.canGoBack()).toBe(true)

    router.back()
    expect(router.canGoBack()).toBe(false)
  })

  test("unsubscribe stops notifications", () => {
    const router = createAppRouter({ current: Route.home(), history: [] })
    const received: AppRouterState[] = []

    const unsubscribe = router.subscribe((state) => received.push(state))
    router.navigate(Route.session("s1", "b1"))
    expect(received.length).toBe(1)

    unsubscribe()
    router.navigate(Route.home())
    expect(received.length).toBe(1) // no new notification
  })

  test("multiple subscribers all notified", () => {
    const router = createAppRouter({ current: Route.home(), history: [] })
    const received1: AppRouterState[] = []
    const received2: AppRouterState[] = []

    router.subscribe((state) => received1.push(state))
    router.subscribe((state) => received2.push(state))
    router.navigate(Route.session("s1", "b1"))

    expect(received1.length).toBe(1)
    expect(received2.length).toBe(1)
  })
})

describe("Route constructors", () => {
  test("Route.home creates home route", () => {
    const route = Route.home()
    expect(route).toEqual({ _tag: "home" })
  })

  test("Route.session creates session route", () => {
    const route = Route.session("session-123", "branch-456")
    expect(route).toEqual({
      _tag: "session",
      sessionId: "session-123",
      branchId: "branch-456",
    })
  })
})

describe("isRoute type guards", () => {
  test("isRoute.home identifies home routes", async () => {
    const { isRoute } = await import("../src/router/types.js")
    expect(isRoute.home(Route.home())).toBe(true)
    expect(isRoute.home(Route.session("s", "b"))).toBe(false)
  })

  test("isRoute.session identifies session routes", async () => {
    const { isRoute } = await import("../src/router/types.js")
    expect(isRoute.session(Route.session("s", "b"))).toBe(true)
    expect(isRoute.session(Route.home())).toBe(false)
  })

  test("type guards narrow types correctly", async () => {
    const { isRoute } = await import("../src/router/types.js")
    const route: AppRoute = Route.session("s1", "b1")

    if (isRoute.session(route)) {
      // TypeScript should know these properties exist
      expect(route.sessionId).toBe("s1")
      expect(route.branchId).toBe("b1")
    }
  })
})
