/**
 * useSkills Hook
 *
 * Fetches skills (with content) from the core Skills service via RPC.
 * Skills are preloaded — content available immediately for $-token expansion.
 */

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { Effect, Fiber } from "effect"
import type { SkillContent } from "@gent/sdk"
import { atom, useAtomValue, useRegistry } from "../atom-solid"
import { useClient } from "../client/index"

export type { SkillContent as SkillInfo }

const REFRESH_INTERVAL = 30_000

export interface UseSkillsReturn {
  skills: Accessor<SkillContent[]>
  isRefreshing: Accessor<boolean>
  refresh: () => void
  getContent: (name: string) => string | null
}

export function useSkills(): UseSkillsReturn {
  const registry = useRegistry()
  const client = useClient()

  type SkillsState =
    | { _tag: "idle"; skills: SkillContent[] }
    | { _tag: "refreshing"; skills: SkillContent[] }

  const skillsAtom = atom((registry) => {
    const [state, setState] = createSignal<SkillsState>({ _tag: "idle", skills: [] })
    const [version, setVersion] = createSignal(0)
    let cancelRefresh: (() => void) | undefined

    const runRefresh = () => {
      const effect = Effect.gen(function* () {
        yield* Effect.sync(() => {
          setState((prev) => ({ _tag: "refreshing", skills: prev.skills }))
        })

        const fresh = yield* client.client.listSkills()
        yield* Effect.sync(() => {
          setState({ _tag: "idle", skills: fresh as SkillContent[] })
        })
      }).pipe(Effect.catchEager(() => Effect.void))

      const services = registry.services
      const fiber = Effect.runForkWith(services)(effect)
      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    }

    const cleanupRefresh = () => {
      if (cancelRefresh === undefined) return
      cancelRefresh()
      cancelRefresh = undefined
    }

    createEffect(() => {
      version()
      cleanupRefresh()
      cancelRefresh = runRefresh()
      onCleanup(cleanupRefresh)
    })

    const interval = setInterval(() => setVersion((v) => v + 1), REFRESH_INTERVAL)
    const dispose = () => {
      cleanupRefresh()
      clearInterval(interval)
    }
    onCleanup(dispose)

    return {
      get: () => state(),
      refresh: () => setVersion((v) => v + 1),
      dispose,
    }
  })

  const state = useAtomValue(skillsAtom)

  const skills = () => state().skills
  const isRefreshing = () => state()._tag === "refreshing"
  const refresh = () => registry.refresh(skillsAtom)

  /** Sync lookup — content is preloaded from the RPC list. */
  const getContent = (name: string): string | null => {
    const skill = state().skills.find((s) => s.name === name)
    return skill?.content ?? null
  }

  return { skills, isRefreshing, refresh, getContent }
}
