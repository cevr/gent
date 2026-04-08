/**
 * useSkills Hook
 *
 * Fetches skills via the @gent/skills extension protocol.
 * Skills are loaded per-session and cached — content available for $-token expansion.
 *
 * The atom is scoped to the current registry so all consumers in the same app
 * share one snapshot without leaking across test/app boundaries.
 */

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { Effect, Fiber } from "effect"
import { SkillsProtocol, type SkillEntry } from "@gent/core/extensions/skills/protocol"
import { type Atom, type Registry, atom, useAtomValue, useRegistry } from "../atom-solid"
import { useClient } from "../client/index"
import type { GentNamespacedClient } from "@gent/sdk"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

export type SkillInfo = SkillEntry

const REFRESH_INTERVAL = 30_000

type SkillsState =
  | { _tag: "idle"; skills: SkillEntry[] }
  | { _tag: "refreshing"; skills: SkillEntry[] }

const sharedAtoms = new WeakMap<Registry, Atom<SkillsState>>()

function createSkillsAtom(
  client: GentNamespacedClient,
  sessionId: () => SessionId | undefined,
  branchId: () => BranchId | undefined,
): Atom<SkillsState> {
  return atom((registry) => {
    const [state, setState] = createSignal<SkillsState>({ _tag: "idle", skills: [] })
    const [version, setVersion] = createSignal(0)
    let cancelRefresh: (() => void) | undefined

    const runRefresh = () => {
      const sid = sessionId()
      if (sid === undefined) return undefined

      const effect = Effect.gen(function* () {
        yield* Effect.sync(() => {
          setState((prev) => ({ _tag: "refreshing", skills: prev.skills }))
        })

        const fresh = yield* client.extension.ask({
          sessionId: sid,
          message: SkillsProtocol.ListSkills(),
          branchId: branchId(),
        })
        yield* Effect.sync(() => {
          setState({ _tag: "idle", skills: [...(fresh as SkillEntry[])] })
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
      // Re-read sessionId reactively
      sessionId()
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

function getOrCreateAtom(
  registry: Registry,
  client: GentNamespacedClient,
  sessionId: () => SessionId | undefined,
  branchId: () => BranchId | undefined,
) {
  const existing = sharedAtoms.get(registry)
  if (existing !== undefined) return existing
  const created = createSkillsAtom(client, sessionId, branchId)
  sharedAtoms.set(registry, created)
  return created
}

export interface UseSkillsReturn {
  skills: Accessor<SkillEntry[]>
  isRefreshing: Accessor<boolean>
  refresh: () => void
  getContent: (name: string) => string | null
}

export function useSkills(): UseSkillsReturn {
  const registry = useRegistry()
  const clientCtx = useClient()

  const skillsAtom = getOrCreateAtom(
    registry,
    clientCtx.client,
    () => clientCtx.session()?.sessionId,
    () => clientCtx.session()?.branchId,
  )
  const state = useAtomValue(skillsAtom)

  const skills = () => state().skills
  const isRefreshing = () => state()._tag === "refreshing"
  const refresh = () => registry.refresh(skillsAtom)

  /** Sync lookup — content is preloaded from the extension protocol. */
  const getContent = (name: string): string | null => {
    const skill = state().skills.find((s) => s.name === name)
    return skill?.content ?? null
  }

  return { skills, isRefreshing, refresh, getContent }
}
