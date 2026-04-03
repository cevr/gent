import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { ExtensionStatusInfo, SendMessageInput } from "@gent/core/server/rpcs"

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

  test("ExtensionStatusInfo round-trips restart supervision fields", () => {
    const payload = {
      manifest: { id: "memory" },
      kind: "builtin",
      sourcePath: "builtin",
      status: "active",
      actor: {
        extensionId: "memory",
        sessionId: "s1",
        branchId: "b1",
        status: "restarting",
        restartCount: 1,
        failurePhase: "runtime",
      },
    }

    const decoded = Schema.decodeUnknownSync(ExtensionStatusInfo)(payload)
    const encoded = Schema.encodeSync(ExtensionStatusInfo)(decoded)

    expect(decoded.actor?.status).toBe("restarting")
    expect(decoded.actor?.restartCount).toBe(1)
    expect(decoded.actor?.failurePhase).toBe("runtime")
    expect(encoded).toEqual(payload)
  })
})
