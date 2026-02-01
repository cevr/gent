/**
 * useScrollSync Hook
 *
 * Provides ID-based scroll synchronization for scrollbox components.
 * Finds elements by ID and scrolls to keep them visible in the viewport.
 */

import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, onCleanup, type Accessor } from "solid-js"

interface ScrollSyncOptions {
  /** The scrollbox ref getter */
  getRef: () => ScrollBoxRenderable | undefined
  /** Number of retries when element not found (default: 15) */
  retries?: number
  /** Delay between retries in ms (default: 30) */
  retryDelay?: number
}

/**
 * ID-based scroll sync - finds element by ID and scrolls to keep it visible
 */
export function useScrollSync(selectedId: Accessor<string>, options: ScrollSyncOptions) {
  const { getRef, retries = 15, retryDelay = 30 } = options

  const syncScroll = (id: string): boolean => {
    const scrollRef = getRef()
    if (scrollRef === undefined) return false

    const children = scrollRef.getChildren()
    const target = children.find((child) => child.id === id)
    if (target === undefined) return false

    const relativeY = target.y - scrollRef.y
    const viewportHeight = scrollRef.height

    // Scroll if element is outside viewport
    if (relativeY < 0) {
      scrollRef.scrollBy(relativeY)
    } else if (relativeY + target.height > viewportHeight) {
      scrollRef.scrollBy(relativeY + target.height - viewportHeight)
    }
    return true
  }

  createEffect(() => {
    const id = selectedId()
    let cancelled = false

    const syncWithRetry = (remaining: number) => {
      if (cancelled || syncScroll(id)) return
      if (remaining > 0) {
        setTimeout(() => syncWithRetry(remaining - 1), retryDelay)
      }
    }

    setTimeout(() => syncWithRetry(retries), 10)
    onCleanup(() => {
      cancelled = true
    })
  })
}
