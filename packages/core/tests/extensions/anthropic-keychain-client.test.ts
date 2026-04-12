import { describe, test, expect } from "bun:test"
import {
  transformPayload,
  transformResponseContent,
  transformStreamEvent,
  transformSystem,
  SYSTEM_IDENTITY_PREFIX,
} from "../../src/extensions/anthropic/keychain-client"

// ── transformPayload ──

describe("transformPayload", () => {
  test("prefixes tool names in tools[]", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tools: [
        { type: "custom", name: "echo", input_schema: { type: "object" } },
        { type: "custom", name: "search", input_schema: { type: "object" } },
      ],
    }
    const result = transformPayload(payload)
    const tools = result["tools"] as Array<{ name: string }>
    expect(tools[0]!.name).toBe("mcp_echo")
    expect(tools[1]!.name).toBe("mcp_search")
  })

  test("prefixes tool_use names in historical messages", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "tc-1", name: "echo", input: { text: "hi" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tc-1", content: "echoed" }],
        },
      ],
    }
    const result = transformPayload(payload)
    const msgs = result["messages"] as Array<{ content: Array<Record<string, unknown>> }>
    const toolUse = msgs[0]!.content[1]!
    expect(toolUse["name"]).toBe("mcp_echo")
  })

  test("does not prefix non-tool_use blocks", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    }
    const result = transformPayload(payload)
    const msgs = result["messages"] as Array<{ content: Array<Record<string, unknown>> }>
    expect(msgs[0]!.content[0]!["type"]).toBe("text")
    expect(msgs[0]!.content[0]!["text"]).toBe("hello")
  })

  test("prefixes tool_choice name when type is tool", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tool_choice: { type: "tool", name: "echo" },
    }
    const result = transformPayload(payload)
    const tc = result["tool_choice"] as { type: string; name: string }
    expect(tc.name).toBe("mcp_echo")
  })

  test("does not modify tool_choice when type is auto", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tool_choice: { type: "auto" },
    }
    const result = transformPayload(payload)
    expect(result["tool_choice"]).toEqual({ type: "auto" })
  })

  test("unconditionally prefixes — mcp_foo becomes mcp_mcp_foo", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tools: [{ type: "custom", name: "mcp_foo", input_schema: { type: "object" } }],
    }
    const result = transformPayload(payload)
    const tools = result["tools"] as Array<{ name: string }>
    expect(tools[0]!.name).toBe("mcp_mcp_foo")
  })

  test("passes through payload without tools/messages", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
    }
    const result = transformPayload(payload)
    expect(result["model"]).toBe("claude-opus-4-6")
    expect(result["max_tokens"]).toBe(4096)
  })
})

// ── transformSystem ──

describe("transformSystem", () => {
  test("returns identity prefix when system is undefined", () => {
    expect(transformSystem(undefined)).toBe(SYSTEM_IDENTITY_PREFIX)
  })

  test("returns identity prefix when system is null", () => {
    expect(transformSystem(null)).toBe(SYSTEM_IDENTITY_PREFIX)
  })

  test("prepends identity to string system", () => {
    const result = transformSystem("Be helpful.") as string
    expect(result.startsWith(SYSTEM_IDENTITY_PREFIX)).toBe(true)
    expect(result).toContain("Be helpful.")
  })

  test("idempotent — does not duplicate identity in string", () => {
    const alreadyPrefixed = `${SYSTEM_IDENTITY_PREFIX}\n\nBe helpful.`
    expect(transformSystem(alreadyPrefixed)).toBe(alreadyPrefixed)
  })

  test("prepends identity block to array system", () => {
    const blocks = [{ type: "text", text: "Be helpful." }]
    const result = transformSystem(blocks) as Array<Record<string, unknown>>
    expect(result.length).toBe(2)
    expect(result[0]!["text"]).toBe(SYSTEM_IDENTITY_PREFIX)
    expect(result[1]!["text"]).toBe("Be helpful.")
  })

  test("idempotent — does not duplicate identity in array", () => {
    const blocks = [
      { type: "text", text: SYSTEM_IDENTITY_PREFIX },
      { type: "text", text: "Be helpful." },
    ]
    const result = transformSystem(blocks) as Array<Record<string, unknown>>
    expect(result.length).toBe(2)
  })

  test("sets cache_control on all system blocks", () => {
    const blocks = [{ type: "text", text: "Be helpful." }]
    const result = transformSystem(blocks) as Array<Record<string, unknown>>
    for (const block of result) {
      expect(block["cache_control"]).toEqual({ type: "ephemeral" })
    }
  })
})

// ── transformResponseContent ──

describe("transformResponseContent", () => {
  test("strips mcp_ prefix from tool_use blocks", () => {
    const content = [
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "tc-1", name: "mcp_echo", input: { text: "hi" } },
    ]
    const result = transformResponseContent(content)
    expect(result[0]!["name"]).toBeUndefined()
    expect(result[1]!["name"]).toBe("echo")
  })

  test("does not modify non-tool_use blocks", () => {
    const content = [{ type: "text", text: "hello" }]
    const result = transformResponseContent(content)
    expect(result[0]).toEqual({ type: "text", text: "hello" })
  })

  test("passes through tool_use without mcp_ prefix", () => {
    const content = [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }]
    const result = transformResponseContent(content)
    expect(result[0]!["name"]).toBe("echo")
  })

  test("strips exactly one mcp_ prefix", () => {
    const content = [{ type: "tool_use", id: "tc-1", name: "mcp_mcp_foo", input: {} }]
    const result = transformResponseContent(content)
    expect(result[0]!["name"]).toBe("mcp_foo")
  })
})

// ── transformStreamEvent ──

describe("transformStreamEvent", () => {
  test("strips mcp_ from content_block_start tool_use events", () => {
    const event = {
      type: "content_block_start" as const,
      index: 1,
      content_block: { type: "tool_use" as const, id: "tc-1", name: "mcp_echo", input: {} },
    }
    const result = transformStreamEvent(event as never)
    const r = result as Record<string, unknown>
    const block = r["content_block"] as Record<string, unknown>
    expect(block["name"]).toBe("echo")
  })

  test("does not modify content_block_start text events", () => {
    const event = {
      type: "content_block_start" as const,
      index: 0,
      content_block: { type: "text" as const, text: "" },
    }
    const result = transformStreamEvent(event as never)
    const r = result as Record<string, unknown>
    const block = r["content_block"] as Record<string, unknown>
    expect(block["type"]).toBe("text")
  })

  test("passes through non-content_block_start events", () => {
    const event = {
      type: "message_start" as const,
      message: { id: "msg-1", type: "message", role: "assistant", content: [] },
    }
    const result = transformStreamEvent(event as never)
    expect(result).toBe(event)
  })

  test("passes through content_block_delta events", () => {
    const event = {
      type: "content_block_delta" as const,
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"text":' },
    }
    const result = transformStreamEvent(event as never)
    expect(result).toBe(event)
  })
})
