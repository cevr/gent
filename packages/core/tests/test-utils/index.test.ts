import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { ExtensionId, SessionId } from "../../src/domain/ids"
import type { Session } from "../../src/domain/message"
import { createToolTestLayer, ensureStorageParents } from "../../src/test-utils/index"
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
  it.live("uses the started resource instance and releases it once", () =>
    Effect.gen(function* () {
      let acquired = 0
      let released = 0
      let started = 0
      const extension = defineExtension({
        id: "resource-instance",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "test/resource-instance",
              scope: "process",
              tag: ResourceInstance,
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
              start: Effect.gen(function* () {
                started = (yield* ResourceInstance).id
              }),
            }),
          )
        }),
      })
      yield* Effect.gen(function* () {
        const instance = yield* ResourceInstance
        expect(instance.id).toBe(started)
        expect(acquired).toBe(1)
        expect(released).toBe(0)
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- The nested scope is the test boundary whose cleanup is under test.
        Effect.provide(createToolTestLayer({ agents: [], extensions: [extension] })),
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
        createToolTestLayer({
          agents: [],
          extensions: ["ext-a", "ext-b"].map((id) =>
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
