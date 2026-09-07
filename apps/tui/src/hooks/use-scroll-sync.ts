/**
 * useScrollSync Hook
 *
 * Provides ID-based scroll synchronization for scrollbox components.
 * Finds elements by ID and scrolls to keep them visible in the viewport.
 */

import type { ScrollBoxRenderable } from "@opentui/core"
import { Effect, Fiber, Option } from "effect"
import { createEffect, onCleanup, type Accessor } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { waitFor } from "../utils/wait-for"

interface ScrollSyncOptions {
  /** Synchronize only while the target list is mounted. */
  enabled?: Accessor<boolean>
  /** The scrollbox ref getter */
  // eslint-disable-next-line effect/noNullish -- OpenTUI refs are absent before attachment and after cleanup.
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
  const renderer = useRenderer()

  const syncScroll = (id: string): Option.Option<true> => {
    const scrollRef = Option.fromNullishOr(getRef())
    if (Option.isNone(scrollRef)) return Option.none()

    const children = scrollRef.value.getChildren()
    const target = Option.fromNullishOr(children.find((child) => child.id === id))
    if (Option.isNone(target)) return Option.none()

    const relativeY = target.value.y - scrollRef.value.y
    const viewportHeight = scrollRef.value.height

    // Scroll if element is outside viewport
    if (relativeY < 0) {
      scrollRef.value.scrollBy(relativeY)
    } else if (relativeY + target.value.height > viewportHeight) {
      scrollRef.value.scrollBy(relativeY + target.value.height - viewportHeight)
    }
    return Option.some(true)
  }

  createEffect(() => {
    if (options.enabled && !options.enabled()) return
    const id = selectedId()
    let fiber = Option.none<Fiber.Fiber<void>>()
    const afterLayout = () => {
      fiber = Option.some(
        Effect.runFork(
          waitFor(() => syncScroll(id), {
            label: `scroll-target ${id}`,
            intervalMs: retryDelay,
            timeoutMs: retries * retryDelay,
          }).pipe(Effect.ignore),
        ),
      )
    }
    renderer.once("frame", afterLayout)
    renderer.requestRender()
    onCleanup(() => {
      renderer.off("frame", afterLayout)
      if (Option.isSome(fiber)) Effect.runFork(Fiber.interrupt(fiber.value))
    })
  })
}
