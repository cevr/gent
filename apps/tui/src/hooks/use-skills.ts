/**
 * useSkills Hook
 *
 * Fetches skills (with content) from the core Skills service via RPC.
 * Skills are preloaded — content available immediately for $-token expansion.
 *
 * The atom is scoped to the current registry so all consumers in the same app
 * share one snapshot without leaking across test/app boundaries.
 */

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { Effect, Fiber } from "effect"
import type { SkillContent, GentNamespacedClient } from "@gent/sdk"
import { type Atom, type Registry, atom, useAtomValue, useRegistry } from "../atom-solid"
import { useClient } from "../client/index"

export type { SkillContent as SkillInfo }

const REFRESH_INTERVAL = 30_000

type SkillsState =
  | { _tag: "idle"; skills: SkillContent[] }
  | { _tag: "refreshing"; skills: SkillContent[] }

const sharedAtoms = new WeakMap<Registry, Atom<SkillsState>>()

function createSkillsAtom(client: GentNamespacedClient): Atom<SkillsState> {
  return atom((registry) => {
    const [state, setState] = createSignal<SkillsState>({ _tag: "idle", skills: [] })
    const [version, setVersion] = createSignal(0)
    let cancelRefresh: (() => void) | undefined

    const runRefresh = () => {
      const effect = Effect.gen(function* () {
        yield* Effect.sync(() => {
          setState((prev) => ({ _tag: "refreshing", skills: prev.skills }))
        })

        const fresh = yield* client.skill.list()
        yield* Effect.sync(() => {
          setState({ _tag: "idle", skills: [...fresh] })
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
}

function getOrCreateAtom(registry: Registry, client: GentNamespacedClient) {
  const existing = sharedAtoms.get(registry)
  if (existing !== undefined) return existing
  const created = createSkillsAtom(client)
  sharedAtoms.set(registry, created)
  return created
}

export interface UseSkillsReturn {
  skills: Accessor<SkillContent[]>
  isRefreshing: Accessor<boolean>
  refresh: () => void
  getContent: (name: string) => string | null
}

export function useSkills(): UseSkillsReturn {
  const registry = useRegistry()
  const client = useClient()

  const skillsAtom = getOrCreateAtom(registry, client.client)
  const state = useAtomValue(skillsAtom)

  const skills = () => state().skills
  const isRefreshing = () => state()._tag === "refreshing"
  const refresh = () => registry.refresh(skillsAtom)

  /** Sync lookup — content is preloaded from the RPC list. */
  const getContent = (name: string): string | null => {
    const skill = state().skills.find((s: SkillContent) => s.name === name)
    return skill?.content ?? null
  }

  return { skills, isRefreshing, refresh, getContent }
}
