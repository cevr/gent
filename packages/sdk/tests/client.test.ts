import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  Gent,
  extractText,
  extractImages,
  Message,
  type Message as DomainMessage,
} from "../src/index"
import { makeNamespacedClient } from "../src/namespaced-client"
import { GentRpcs, type GentRpcClient } from "@gent/core/server/rpcs"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { ToolCallPart, ToolResultPart } from "@gent/core/domain/message"
import {
  buildToolResultMapFromMessages,
  messagePartsToolInteractions,
} from "@gent/core/domain/message-part-projection"

describe("sdk client helpers", () => {
  test("sdk entrypoint exports the public constructors", () => {
    expect(typeof Gent.server).toBe("function")
    expect(typeof Gent.client).toBe("function")
    expect(typeof Gent.test).toBe("function")
    expect(typeof Gent.state.sqlite).toBe("function")
    expect(typeof Gent.state.memory).toBe("function")
    expect(typeof Gent.provider.live).toBe("function")
    expect(typeof Gent.provider.mock).toBe("function")
  })

  test("extractText extracts text from message parts", () => {
    const parts = [{ type: "text" as const, text: "Hello world" }]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("extractImages extracts image metadata", () => {
    const parts = [{ type: "image" as const, image: "base64data", mediaType: "image/png" }]
    const images = extractImages(parts)
    expect(images.length).toBe(1)
    expect(images[0]?.mediaType).toBe("image/png")
  })

  test("canonical tool interactions expose running calls", () => {
    const parts = [
      ToolCallPart.make({
        type: "tool-call" as const,
        toolCallId: ToolCallId.make("tc1"),
        toolName: "read",
        input: { path: "/foo" },
      }),
    ]
    const calls = messagePartsToolInteractions(parts, new Map())
    expect(calls.length).toBe(1)
    expect(calls[0]?.id).toBe("tc1")
    expect(calls[0]?.toolName).toBe("read")
    expect(calls[0]?.status).toBe("running")
  })

  test("canonical tool result state indexes tool outputs by call id", () => {
    const messages: DomainMessage[] = [
      Message.Regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s1"),
        branchId: BranchId.make("b1"),
        role: "tool",
        parts: [
          ToolResultPart.make({
            type: "tool-result",
            toolCallId: ToolCallId.make("tc1"),
            toolName: "read",
            output: { type: "json", value: "file contents" },
          }),
        ],
        createdAt: new Date(),
      }),
    ]
    const map = buildToolResultMapFromMessages(messages)
    expect(map.size).toBe(1)
    expect(map.get("tc1")?.output).toBe("file contents")
  })

  test("namespaced client exposes every RPC key from GentRpcs", () => {
    const handlers = new Map<string, () => Effect.Effect<void>>(
      [...GentRpcs.requests.keys()].map((key) => [key, () => Effect.void]),
    )
    const flat = new Proxy(Object.create(null) as GentRpcClient, {
      get: (_target, property) =>
        typeof property === "string" ? handlers.get(property) : undefined,
    })
    const namespaced = makeNamespacedClient(flat)
    expect(namespaced.session).toBe(namespaced.session)

    for (const key of GentRpcs.requests.keys()) {
      const separator = key.indexOf(".")
      if (separator === -1) {
        throw new Error(`RPC key is not namespaced: ${key}`)
      }
      const namespace = key.slice(0, separator)
      const method = key.slice(separator + 1)
      const namespaceClient = namespaced[namespace as keyof typeof namespaced]
      expect(namespaceClient).toBeDefined()
      expect(namespace in namespaced).toBe(true)
      expect(method in namespaceClient).toBe(true)
      const methodClient = (namespaceClient as Readonly<Record<string, unknown>>)[method]
      expect(methodClient).toBeDefined()
      expect(methodClient).toBe(handlers.get(key))
    }
  })
})
