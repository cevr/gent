import { describe, test, expect } from "bun:test"
import { routerReducer, createAppRouter, type RouterAction } from "../src/router/router"
import { Route, isRoute, type AppRoute, type AppRouterState } from "../src/router/types"

describe("routerReducer", () => {
  const initialState: AppRouterState = {
    current: Route.session("s0", "b0"),
    history: [],
  }

  test("navigate to different route type pushes to history", () => {
    const action: RouterAction = {
      type: "navigate",
      route: Route.branchPicker("s1", "Pick", []),
    }
    const next = routerReducer(initialState, action)

    expect(next.current._tag).toBe("branchPicker")
    expect(next.history).toEqual([{ _tag: "session", sessionId: "s0", branchId: "b0" }])
  })

  test("navigate to same route type replaces without history", () => {
    const state: AppRouterState = {
      current: Route.session("s1", "b1"),
      history: [Route.branchPicker("s0", "Pick", [])],
    }
    const action: RouterAction = {
      type: "navigate",
      route: Route.session("s2", "b2"),
    }
    const next = routerReducer(state, action)

    expect(next.current).toEqual({ _tag: "session", sessionId: "s2", branchId: "b2" })
    expect(next.history.length).toBe(1) // unchanged
  })

  test("back pops from history", () => {
    const state: AppRouterState = {
      current: Route.branchPicker("s1", "Pick", []),
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

    state = routerReducer(state, {
      type: "navigate",
      route: Route.branchPicker("s1", "Pick", []),
    })
    expect(state.history.length).toBe(1)

    state = routerReducer(state, { type: "navigate", route: Route.session("s1", "b1") })
    expect(state.history.length).toBe(2)

    state = routerReducer(state, {
      type: "navigate",
      route: Route.branchPicker("s2", "Pick2", []),
    })
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
    router.navigate(Route.branchPicker("s1", "Pick", []))

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

    router.navigate(Route.branchPicker("s1", "Pick", []))
    expect(router.canGoBack()).toBe(true)

    router.back()
    expect(router.canGoBack()).toBe(false)
  })

  test("unsubscribe stops notifications", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })
    const received: AppRouterState[] = []

    const unsubscribe = router.subscribe((state) => received.push(state))
    router.navigate(Route.branchPicker("s1", "Pick", []))
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
    router.navigate(Route.branchPicker("s1", "Pick", []))

    expect(received1.length).toBe(1)
    expect(received2.length).toBe(1)
  })
})

describe("Route constructors", () => {
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
  test("isRoute.session identifies session routes", () => {
    expect(isRoute.session(Route.session("s", "b"))).toBe(true)
    expect(isRoute.session(Route.branchPicker("s", "P", []))).toBe(false)
  })

  test("type guards narrow types correctly", () => {
    const route: AppRoute = Route.session("s1", "b1")

    if (isRoute.session(route)) {
      expect(route.sessionId).toBe("s1")
      expect(route.branchId).toBe("b1")
    }
  })
})

describe("route invariants", () => {
  test("AppRoute union only has session and branchPicker", () => {
    // Route constructors are the only way to create routes — if this compiles
    // and these are the only keys, the union is exactly session | branchPicker.
    const constructors = Object.keys(Route)
    expect(constructors.sort()).toEqual(["branchPicker", "session"])
  })

  test("isRoute guards cover all route types", () => {
    const guards = Object.keys(isRoute)
    expect(guards.sort()).toEqual(["branchPicker", "session"])
  })
})
