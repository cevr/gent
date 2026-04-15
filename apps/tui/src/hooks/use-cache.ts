/**
 * Simple key-based cache for Effect results
 */
import type { Accessor } from "solid-js"
import type { Result } from "../atom-solid/result"

// Global cache for Effect results
const cache = new Map<string, Accessor<Result<unknown, unknown>>>()
const cancels = new Map<string, () => void>()

/**
 * Get or create a cached result accessor
 * @param key - Cache key
 * @param run - Factory function that returns [result accessor, cancel fn]
 */
export function cached<A, E>(
  key: string,
  run: () => [Accessor<Result<A, E>>, () => void],
): Accessor<Result<A, E>> {
  if (cache.has(key)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return cache.get(key) as Accessor<Result<A, E>>
  }

  const [result, cancel] = run()
  cache.set(key, result as Accessor<Result<unknown, unknown>>)
  cancels.set(key, cancel)
  return result
}

/** Invalidate a single cache entry */
export function invalidate(key: string): void {
  cancels.get(key)?.()
  cancels.delete(key)
  cache.delete(key)
}

/** Invalidate all cache entries */
export function invalidateAll(): void {
  for (const cancel of cancels.values()) cancel()
  cancels.clear()
  cache.clear()
}

/** Check if key exists in cache */
export function has(key: string): boolean {
  return cache.has(key)
}
