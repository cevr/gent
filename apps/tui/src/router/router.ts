/**
 * Pure router logic - reducer + state machine
 */

import type { AppRoute, AppRouterState } from "./types"

export type RouterAction =
  | { readonly type: "navigate"; readonly route: AppRoute }
  | { readonly type: "back" }

export function routerReducer(state: AppRouterState, action: RouterAction): AppRouterState {
  switch (action.type) {
    case "navigate": {
      // Same route type: replace current (don't push to history)
      if (state.current._tag === action.route._tag) {
        return { ...state, current: action.route }
      }
      // Different route type: push current to history
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
