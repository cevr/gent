import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import {
  DynamicExtensionRegistry,
  DynamicRegistrationError,
  type DynamicRegistrationScope,
} from "../../src/domain/dynamic-extension-registry"
import { ExtensionId, SessionId } from "../../src/domain/ids"
import { request, tool } from "@gent/core/extensions/api"

describe("dynamic extension registry", () => {
  const makeTool = (id: string, response: string) =>
    tool({
      id,
      description: id,
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.succeed(response),
    })

  const makeRequest = (extensionId: ExtensionId, id: string, response: string) =>
    request({
      id,
      extensionId,
      slash: { name: id, description: id },
      input: Schema.Void,
      output: Schema.String,
      description: response,
      execute: () => Effect.succeed(response),
    })

  it.live("rejects duplicate dynamic tools in the same scope until the finalizer runs", () =>
    Effect.gen(function* () {
      const registry = yield* DynamicExtensionRegistry
      const sessionId = SessionId.make("session-a")
      const firstTool = makeTool("dynamic_echo", "first")
      const secondTool = makeTool("dynamic_echo", "second")
      const unregister = yield* registry.registerTool({
        extensionId: ExtensionId.make("@test/first"),
        scope: { _tag: "session", sessionId },
        capability: firstTool,
      })

      const duplicate = yield* registry
        .registerTool({
          extensionId: ExtensionId.make("@test/second"),
          scope: { _tag: "session", sessionId },
          capability: secondTool,
        })
        .pipe(Effect.exit)
      expect(duplicate._tag).toBe("Failure")
      if (duplicate._tag === "Failure") {
        const error = Cause.squash(duplicate.cause)
        expect(Schema.is(DynamicRegistrationError)(error)).toBe(true)
        if (!Schema.is(DynamicRegistrationError)(error)) return
        expect(error.message).toContain(
          'dynamic tool "dynamic_echo" is already registered for session session-a',
        )
      }

      yield* unregister
      const secondUnregister = yield* registry.registerTool({
        extensionId: ExtensionId.make("@test/second"),
        scope: { _tag: "session", sessionId },
        capability: secondTool,
      })
      void secondUnregister
      const tools = yield* registry.listTools(sessionId)
      expect(tools).toHaveLength(1)
    }).pipe(Effect.provide(DynamicExtensionRegistry.Live)),
  )

  it.live("keeps a re-registered tool owned by its new finalizer", () =>
    Effect.gen(function* () {
      const registry = yield* DynamicExtensionRegistry
      const sessionId = SessionId.make("session-a")
      const entry = {
        extensionId: ExtensionId.make("@test/tool-owner"),
        scope: { _tag: "session", sessionId } satisfies DynamicRegistrationScope,
        capability: makeTool("same-object-tool", "value"),
      }

      const unregisterFirst = yield* registry.registerTool(entry)
      yield* unregisterFirst
      const unregisterSecond = yield* registry.registerTool(entry)

      // The first cleanup must not remove the second registration.
      yield* unregisterFirst
      const afterOldCleanup = yield* registry.listTools(sessionId)
      expect(afterOldCleanup).toHaveLength(1)

      yield* unregisterSecond
      yield* unregisterSecond
      const afterRepeatedCleanup = yield* registry.listTools(sessionId)
      expect(afterRepeatedCleanup).toHaveLength(0)
    }).pipe(Effect.provide(DynamicExtensionRegistry.Live)),
  )

  it.live("keeps a re-registered request owned by its new finalizer", () =>
    Effect.gen(function* () {
      const registry = yield* DynamicExtensionRegistry
      const sessionId = SessionId.make("session-a")
      const extensionId = ExtensionId.make("@test/request-owner")
      const entry = {
        extensionId,
        scope: { _tag: "session", sessionId } satisfies DynamicRegistrationScope,
        capability: makeRequest(extensionId, "same-object-request", "value"),
      }

      const unregisterFirst = yield* registry.registerRequest(entry)
      yield* unregisterFirst
      const unregisterSecond = yield* registry.registerRequest(entry)

      // The first cleanup must not remove the second registration.
      yield* unregisterFirst
      const afterOldCleanup = yield* registry.findRequest({
        sessionId,
        extensionId,
        capabilityId: "same-object-request",
      })
      expect(Option.isSome(afterOldCleanup)).toBe(true)

      yield* unregisterSecond
      yield* unregisterSecond
      const afterRepeatedCleanup = yield* registry.findRequest({
        sessionId,
        extensionId,
        capabilityId: "same-object-request",
      })
      expect(Option.isNone(afterRepeatedCleanup)).toBe(true)
    }).pipe(Effect.provide(DynamicExtensionRegistry.Live)),
  )

  it.live("admits only one concurrent tool registration for one id and scope", () =>
    Effect.gen(function* () {
      const registry = yield* DynamicExtensionRegistry
      const sessionId = SessionId.make("session-race")
      const attempts = Array.from({ length: 16 }, (_, index) =>
        registry
          .registerTool({
            extensionId: ExtensionId.make(`@test/tool-race-${index}`),
            scope: { _tag: "session", sessionId },
            capability: makeTool("concurrent-tool", String(index)),
          })
          .pipe(Effect.exit),
      )
      const results = yield* Effect.all(attempts, { concurrency: 16 })
      const successes = results.filter(Exit.isSuccess)
      const failures = results.filter(Exit.isFailure)
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(attempts.length - 1)
      for (const failure of failures) {
        if (!Exit.isFailure(failure)) continue
        expect(Schema.is(DynamicRegistrationError)(Cause.squash(failure.cause))).toBe(true)
      }

      for (const success of successes) {
        if (Exit.isSuccess(success)) yield* success.value
      }
    }).pipe(Effect.provide(DynamicExtensionRegistry.Live)),
  )

  it.live("admits only one concurrent request registration for one id and scope", () =>
    Effect.gen(function* () {
      const registry = yield* DynamicExtensionRegistry
      const sessionId = SessionId.make("session-request-race")
      const attempts = Array.from({ length: 16 }, (_, index) => {
        const extensionId = ExtensionId.make(`@test/request-race-${index}`)
        return registry
          .registerRequest({
            extensionId,
            scope: { _tag: "session", sessionId },
            capability: makeRequest(extensionId, "concurrent-request", String(index)),
          })
          .pipe(Effect.exit)
      })
      const results = yield* Effect.all(attempts, { concurrency: 16 })
      const successes = results.filter(Exit.isSuccess)
      const failures = results.filter(Exit.isFailure)
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(attempts.length - 1)
      for (const failure of failures) {
        if (!Exit.isFailure(failure)) continue
        expect(Schema.is(DynamicRegistrationError)(Cause.squash(failure.cause))).toBe(true)
      }

      for (const success of successes) {
        if (Exit.isSuccess(success)) yield* success.value
      }
    }).pipe(Effect.provide(DynamicExtensionRegistry.Live)),
  )

  it.live("lets session dynamic capabilities shadow process capabilities", () =>
    Effect.gen(function* () {
      const registry = yield* DynamicExtensionRegistry
      const extensionId = ExtensionId.make("@test/dynamic")
      const sessionId = SessionId.make("session-a")
      const otherSessionId = SessionId.make("session-b")

      const unregisterProcessTool = yield* registry.registerTool({
        extensionId,
        scope: { _tag: "process" },
        capability: makeTool("dynamic_echo", "process"),
      })
      const unregisterSessionTool = yield* registry.registerTool({
        extensionId,
        scope: { _tag: "session", sessionId },
        capability: makeTool("dynamic_echo", "session"),
      })
      void unregisterProcessTool
      void unregisterSessionTool

      const unregisterProcessRequest = yield* registry.registerRequest({
        extensionId,
        scope: { _tag: "process" },
        capability: makeRequest(extensionId, "dynamic-echo", "process"),
      })
      const unregisterSessionRequest = yield* registry.registerRequest({
        extensionId,
        scope: { _tag: "session", sessionId },
        capability: makeRequest(extensionId, "dynamic-echo", "session"),
      })
      void unregisterProcessRequest
      void unregisterSessionRequest

      const sessionTools = yield* registry.listTools(sessionId)
      const processTools = yield* registry.listTools(otherSessionId)
      expect(sessionTools.map((capability) => capability.description)).toEqual(["dynamic_echo"])
      expect(processTools.map((capability) => capability.description)).toEqual(["dynamic_echo"])

      const sessionRequest = yield* registry.findRequest({
        sessionId,
        extensionId,
        capabilityId: "dynamic-echo",
      })
      const processRequest = yield* registry.findRequest({
        sessionId: otherSessionId,
        extensionId,
        capabilityId: "dynamic-echo",
      })
      expect(Option.getOrUndefined(sessionRequest)?.capability.description).toBe("session")
      expect(Option.getOrUndefined(processRequest)?.capability.description).toBe("process")
    }).pipe(Effect.provide(DynamicExtensionRegistry.Live)),
  )
})
