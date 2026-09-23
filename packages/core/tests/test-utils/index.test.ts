import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { ExtensionId, SessionId } from "../../src/domain/ids"
import type { Session } from "../../src/domain/message"
import {
  createE2ELayer,
  ensureStorageParents,
  type E2ELayerConfig,
} from "../../src/test-utils/harness"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { SessionStorage, type SessionStorageService } from "../../src/storage/storage"
import { ExtensionRegistry } from "../../src/runtime/extension-host"
import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api"

// ── ensure-storage-parents.test ─────────────────────────────────────────────

const sessionOnlyLayer = (sessions: Ref.Ref<ReadonlyMap<SessionId, Session>>) =>
  Layer.succeed(SessionStorage, {
    createSession: (session) =>
      Ref.update(sessions, (map) => new Map(map).set(session.id, session)).pipe(Effect.as(session)),
    getSession: (id) => Ref.get(sessions).pipe(Effect.map((map) => map.get(id))),
    listSessions: Ref.get(sessions).pipe(Effect.map((map) => [...map.values()])),
    updateSession: (session) =>
      Ref.update(sessions, (map) => new Map(map).set(session.id, session)).pipe(Effect.as(session)),
    deleteSession: (id) =>
      Ref.modify(sessions, (map) => {
        const next = new Map(map)
        next.delete(id)
        return [[id], next]
      }),
  } satisfies SessionStorageService)

/** The server root with the stub tool runner, the scripted model, and no agents. */
const toolLayer = (config: Pick<E2ELayerConfig, "extensionInputs" | "allowFailedExtensions">) =>
  createE2ELayer({
    ...config,
    providerLayer: LanguageModelLayers.debug(),
    agents: [],
    toolRunner: "test",
  })

describe("ensureStorageParents", () => {
  it.live("creates a session without requiring branch storage", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyMap<SessionId, Session>>(new Map())
      const sessionId = SessionId.make("session-only")

      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      yield* ensureStorageParents({ sessionId }).pipe(Effect.provide(sessionOnlyLayer(sessions)))

      const stored = yield* Ref.get(sessions)
      expect(stored.has(sessionId)).toBe(true)
    }),
  )
})

// ── extension-tool-layer.test ───────────────────────────────────────────────

class ResourceInstance extends Context.Service<ResourceInstance, { readonly id: number }>()(
  "@gent/core/tests/test-utils/index.test/ResourceInstance",
) {}

describe("extension tool test layer", () => {
  it.live("uses the one built resource instance and releases it once", () =>
    Effect.gen(function* () {
      let acquired = 0
      let released = 0
      const extension = defineExtension({
        id: "resource-instance",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "test/resource-instance",
              scope: "process",
              layer: Layer.effect(
                ResourceInstance,
                Effect.acquireRelease(
                  Effect.sync(() => ({ id: ++acquired })),
                  () =>
                    Effect.sync(() => {
                      released++
                    }),
                ),
              ),
            }),
          )
        }),
      })
      yield* Effect.gen(function* () {
        const instance = yield* ResourceInstance
        expect(instance.id).toBe(1)
        expect(acquired).toBe(1)
        expect(released).toBe(0)
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- The nested scope is the test boundary whose cleanup is under test.
        Effect.provide(toolLayer({ extensionInputs: [extension] })),
        Effect.scoped,
      )
      expect(released).toBe(1)
    }),
  )

  it.scopedLive("excludes both extensions when tools collide in the same scope", () =>
    Effect.gen(function* () {
      const registry = yield* ExtensionRegistry
      const resolved = registry.getResolved()
      expect([...resolved.modelCapabilities.values()]).toEqual([])
      expect(resolved.failedExtensions.map((failure) => failure.manifest.id).sort()).toEqual([
        ExtensionId.make("ext-a"),
        ExtensionId.make("ext-b"),
      ])
      expect(resolved.failedExtensions.every((failure) => failure.phase === "validation")).toBe(
        true,
      )
    }).pipe(
      Effect.provide(
        toolLayer({
          // The collision is the subject, so the layer keeps both failures to inspect.
          allowFailedExtensions: true,
          extensionInputs: ["ext-a", "ext-b"].map((id) =>
            defineExtension({
              id,
              setup: Effect.gen(function* () {
                const host = yield* ExtensionHost
                yield* host.register(
                  "tool",
                  tool({
                    id: "conflict",
                    description: id,
                    params: Schema.Struct({}),
                    output: Schema.Void,
                    execute: () => Effect.void,
                  }),
                )
              }),
            }),
          ),
        }),
      ),
    ),
  )
})
