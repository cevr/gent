import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Schema } from "effect"
import { DynamicExtensionRegistry } from "../../src/domain/dynamic-extension-registry"
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
        const error = Cause.squash(duplicate.cause) as { readonly message?: string }
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
      expect(sessionRequest?.capability.description).toBe("session")
      expect(processRequest?.capability.description).toBe("process")
    }).pipe(Effect.provide(DynamicExtensionRegistry.Live)),
  )
})
