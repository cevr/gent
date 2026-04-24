import { describe, test, expect } from "bun:test"
import { createAppRouter } from "../src/router/router"
import { Route, type AppRouterState } from "../src/router/types"

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

  test("same-route navigation replaces the visible route without growing history", () => {
    const router = createAppRouter({ current: Route.session("s1", "b1"), history: [] })

    router.navigate(Route.branchPicker("s1", "Pick", []))
    router.navigate(Route.branchPicker("s2", "Pick again", []))

    expect(router.getState()).toEqual({
      current: { _tag: "branchPicker", sessionId: "s2", sessionName: "Pick again", branches: [] },
      history: [{ _tag: "session", sessionId: "s1", branchId: "b1" }],
    })
  })
})
