import { describe, test, expect } from "bun:test"
import { routerReducer, createAppRouter, type RouterAction } from "../src/router/router"
import { Route, type AppRoute, type AppRouterState } from "../src/router/types"

describe("routerReducer", () => {
  const initialState: AppRouterState = {
    current: Route.session("s0", "b0"),
    history: [],
  }

  test("navigate to different route type pushes to history", () => {
    const action: RouterAction = {
      type: "navigate",
      route: Route.auth(),
    }
    const next = routerReducer(initialState, action)

    expect(next.current).toEqual({ _tag: "auth" })
    expect(next.history).toEqual([{ _tag: "session", sessionId: "s0", branchId: "b0" }])
  })

  test("navigate to same route type replaces without history", () => {
    const state: AppRouterState = {
      current: Route.session("s1", "b1"),
      history: [Route.auth()],
    }
    const action: RouterAction = {
      type: "navigate",
      route: Route.session("s2", "b2"),
    }
    const next = routerReducer(state, action)

    expect(next.current).toEqual({ _tag: "session", sessionId: "s2", branchId: "b2" })
    expect(next.history).toEqual([{ _tag: "auth" }]) // unchanged
  })

  test("back pops from history", () => {
    const state: AppRouterState = {
      current: Route.auth(),
      history: [Route.session("s1", "b1")],
    }
    const next = routerReducer(state, { type: "back" })

    expect(next.current).toEqual({ _tag: "session", sessionId: "s1", branchId: "b1" })
    expect(next.history).toEqual([])
  })

  test("back with empty history is no-op", () => {
    const state: AppRouterState = {
      current: Route.session("s1", "b1"),
      history: [],
    }
    const next = routerReducer(state, { type: "back" })

    expect(next).toBe(state) // same reference
  })

  test("multiple navigations build history stack", () => {
    let state = initialState

    state = routerReducer(state, { type: "navigate", route: Route.auth() })
    expect(state.history.length).toBe(1)

    state = routerReducer(state, { type: "navigate", route: Route.session("s1", "b1") })
    expect(state.history.length).toBe(2)

    state = routerReducer(state, { type: "navigate", route: Route.permissions() })
    expect(state.history.length).toBe(3)
  })
})

describe("createAppRouter", () => {
  test("getState returns initial state", () => {
    const initial: AppRouterState = { current: Route.session("s1", "b1"), history: [] }
    const router = createAppRouter(initial)

    expect(router.getState()).toEqual(initial)
  })

  test("navigate updates state and notifies subscribers", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })
    const received: AppRouterState[] = []

    router.subscribe((state) => received.push(state))
    router.navigate(Route.session("s2", "b2"))

    expect(router.getState().current).toEqual({ _tag: "session", sessionId: "s2", branchId: "b2" })
    expect(received.length).toBe(1)
    expect(received[0]?.current).toEqual({ _tag: "session", sessionId: "s2", branchId: "b2" })
  })

  test("back returns true when history exists", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })
    router.navigate(Route.auth())

    expect(router.back()).toBe(true)
    expect(router.getState().current).toEqual({ _tag: "session", sessionId: "s1", branchId: "b1" })
  })

  test("back returns false when no history", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })

    expect(router.back()).toBe(false)
    expect(router.getState().current).toEqual({ _tag: "session", sessionId: "s1", branchId: "b1" })
  })

  test("canGoBack reflects history state", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })

    expect(router.canGoBack()).toBe(false)

    router.navigate(Route.auth())
    expect(router.canGoBack()).toBe(true)

    router.back()
    expect(router.canGoBack()).toBe(false)
  })

  test("unsubscribe stops notifications", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })
    const received: AppRouterState[] = []

    const unsubscribe = router.subscribe((state) => received.push(state))
    router.navigate(Route.auth())
    expect(received.length).toBe(1)

    unsubscribe()
    router.navigate(Route.session("s2", "b2"))
    expect(received.length).toBe(1) // no new notification
  })

  test("multiple subscribers all notified", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })
    const received1: AppRouterState[] = []
    const received2: AppRouterState[] = []

    router.subscribe((state) => received1.push(state))
    router.subscribe((state) => received2.push(state))
    router.navigate(Route.auth())

    expect(received1.length).toBe(1)
    expect(received2.length).toBe(1)
  })
})

describe("Route constructors", () => {
  test("Route.loading creates loading route", () => {
    const route = Route.loading()
    expect(route).toEqual({ _tag: "loading" })
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
  test("isRoute.loading identifies loading routes", async () => {
    const { isRoute } = await import("../src/router/types.js")
    expect(isRoute.loading(Route.loading())).toBe(true)
    expect(isRoute.loading(Route.auth())).toBe(false)
  })

  test("isRoute.session identifies session routes", async () => {
    const { isRoute } = await import("../src/router/types.js")
    expect(isRoute.session(Route.session("s", "b"))).toBe(true)
    expect(isRoute.session(Route.auth())).toBe(false)
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
