import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { ExtensionHealthSnapshot, SendMessageInput } from "@gent/core/server/rpcs"

describe("SendMessage API", () => {
  test("SendMessageInput decodes required fields", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
    }
    const decoded = Schema.decodeUnknownSync(SendMessageInput)(payload)
    expect(decoded.content).toBe("Hello")
    expect(decoded.sessionId).toBe("s1")
    expect(decoded.branchId).toBe("b1")
  })

  test("SendMessageInput rejects missing content", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
    }
    expect(() => Schema.decodeUnknownSync(SendMessageInput)(payload)).toThrow()
  })

  test("ExtensionHealthSnapshot round-trips restart supervision fields", () => {
    const payload = {
      extensions: [
        {
          manifest: { id: "memory" },
          kind: "builtin",
          sourcePath: "builtin",
          status: "degraded",
          activation: {
            status: "active",
          },
          actor: {
            extensionId: "memory",
            sessionId: "s1",
            branchId: "b1",
            status: "restarting",
            restartCount: 1,
            failurePhase: "runtime",
          },
          scheduler: {
            status: "healthy",
            failures: [],
          },
        },
      ],
      summary: {
        status: "degraded",
        failedExtensions: [],
        failedActors: [],
        failedScheduledJobs: [],
      },
    }

    const decoded = Schema.decodeUnknownSync(ExtensionHealthSnapshot)(payload)
    const encoded = Schema.encodeSync(ExtensionHealthSnapshot)(decoded)

    expect(decoded.extensions[0]?.actor?.status).toBe("restarting")
    expect(decoded.extensions[0]?.actor?.restartCount).toBe(1)
    expect(decoded.extensions[0]?.actor?.failurePhase).toBe("runtime")
    expect(encoded).toEqual(payload)
  })
})
