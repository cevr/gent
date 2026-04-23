import { describe, test, expect } from "bun:test"
import { routerReducer, createAppRouter, type RouterAction } from "../src/router/router"
import { Route, type AppRouterState } from "../src/router/types"

describe("routerReducer", () => {
  const initialState: AppRouterState = {
    current: Route.session("s0", "b0"),
    history: [],
  }

  test("cross-route navigation builds a back stack and same-route navigation replaces in place", () => {
    const action: RouterAction = {
      type: "navigate",
      route: Route.branchPicker("s1", "Pick", []),
    }
    const branchPicker = routerReducer(initialState, action)
    const replacement = routerReducer(branchPicker, {
      type: "navigate",
      route: Route.branchPicker("s2", "Pick again", []),
    })
    const session = routerReducer(replacement, {
      type: "navigate",
      route: Route.session("s2", "b2"),
    })

    expect(branchPicker.history).toEqual([{ _tag: "session", sessionId: "s0", branchId: "b0" }])
    expect(replacement.history).toEqual(branchPicker.history)
    expect(session.history).toEqual([
      { _tag: "session", sessionId: "s0", branchId: "b0" },
      { _tag: "branchPicker", sessionId: "s2", sessionName: "Pick again", branches: [] },
    ])
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
})

describe("createAppRouter", () => {
  test("notifies subscribers for route changes and honors unsubscription", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })
    const received: AppRouterState[] = []

    const unsubscribe = router.subscribe((state) => received.push(state))
    router.navigate(Route.branchPicker("s1", "Pick", []))

    expect(router.getState().current).toEqual({
      _tag: "branchPicker",
      sessionId: "s1",
      sessionName: "Pick",
      branches: [],
    })
    expect(received.length).toBe(1)

    unsubscribe()
    router.navigate(Route.session("s2", "b2"))
    expect(received.length).toBe(1)
  })

  test("back reports whether it changed the visible route", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })

    expect(router.back()).toBe(false)
    expect(router.canGoBack()).toBe(false)

    router.navigate(Route.branchPicker("s1", "Pick", []))
    expect(router.canGoBack()).toBe(true)

    expect(router.back()).toBe(true)
    expect(router.getState().current).toEqual({ _tag: "session", sessionId: "s1", branchId: "b1" })
    expect(router.canGoBack()).toBe(false)
    expect(router.back()).toBe(false)
  })
})
