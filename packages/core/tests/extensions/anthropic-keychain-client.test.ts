import { describe, test, expect } from "bun:test"
import {
  repairToolPairs,
  transformPayload,
  transformResponseContent,
  transformStreamEvent,
  transformSystem,
  SYSTEM_IDENTITY_PREFIX,
} from "@gent/extensions/anthropic/keychain-client"

// ── transformPayload ──

describe("transformPayload", () => {
  // Tool names go on the wire as `mcp_<PascalCase>` — Anthropic's OAuth
  // billing validator rejects lowercase-after-prefix tool names when
  // multiple tools are present (matches Claude Code's PascalCase
  // convention; opencode-claude-auth issue notes).
  test("prefixes tool names in tools[] with PascalCase", () => {
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
    expect(tools[0]!.name).toBe("mcp_Echo")
    expect(tools[1]!.name).toBe("mcp_Search")
  })

  test("prefixes tool_use names in historical messages with PascalCase", () => {
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
    expect(toolUse["name"]).toBe("mcp_Echo")
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

  test("prefixes tool_choice name with PascalCase when type is tool", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tool_choice: { type: "tool", name: "echo" },
    }
    const result = transformPayload(payload)
    const tc = result["tool_choice"] as { type: string; name: string }
    expect(tc.name).toBe("mcp_Echo")
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

  test("unconditionally prefixes — mcp_foo becomes mcp_Mcp_foo", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tools: [{ type: "custom", name: "mcp_foo", input_schema: { type: "object" } }],
    }
    const result = transformPayload(payload)
    const tools = result["tools"] as Array<{ name: string }>
    expect(tools[0]!.name).toBe("mcp_Mcp_foo")
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

// ── repairToolPairs (counsel C7 / opencode parity B) ──

describe("repairToolPairs", () => {
  test("drops orphan tool_use blocks (no matching downstream tool_result)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "trying" },
          { type: "tool_use", id: "tc-1", name: "echo", input: {} },
          { type: "tool_use", id: "tc-2", name: "echo", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-1", content: "ok" }],
      },
    ]
    const repaired = repairToolPairs(messages)
    const assistantContent = repaired[0]!["content"] as Array<Record<string, unknown>>
    // tool_use tc-2 is dropped; tc-1 + the text block survive.
    expect(assistantContent).toHaveLength(2)
    expect(assistantContent.find((b) => b["id"] === "tc-1")).toBeDefined()
    expect(assistantContent.find((b) => b["id"] === "tc-2")).toBeUndefined()
  })

  test("drops orphan tool_result blocks (no matching upstream tool_use)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc-orphan", content: "stale" },
          { type: "text", text: "follow-up" },
        ],
      },
    ]
    const repaired = repairToolPairs(messages)
    const userContent = repaired[0]!["content"] as Array<Record<string, unknown>>
    expect(userContent).toHaveLength(1)
    expect(userContent[0]!["type"]).toBe("text")
  })

  test("removes a message whose content fully empties out after filtering", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-only", name: "echo", input: {} }],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!["role"]).toBe("user")
  })

  test("returns input unchanged when every pair matches", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-1", content: "ok" }],
      },
    ]
    const repaired = repairToolPairs(messages)
    // Same reference — no defensive copy when nothing to repair.
    expect(repaired).toBe(messages)
  })

  test("ignores messages whose content is a string (no tool blocks possible)", () => {
    const messages = [
      { role: "user", content: "plain text" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
      },
    ]
    // No tool_result for tc-1, so the assistant's tool_use is orphaned
    // and gets dropped — but the string-content user message rides
    // through untouched.
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!["content"]).toBe("plain text")
  })
})

// ── system relocation (counsel C7 / opencode parity A) ──

describe("transformPayload — system content relocation", () => {
  test("moves third-party system blocks into the first user message", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [
        { type: "text", text: "third-party system instructions" },
        { type: "text", text: "additional rules" },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }
    const result = transformPayload(payload)
    const system = result["system"] as Array<{ text?: string }>
    // After relocation, system[] holds only billing + identity entries.
    expect(system).toHaveLength(2)
    const systemTexts = system.map((b) => b.text ?? "")
    expect(systemTexts.some((t) => t.startsWith("x-anthropic-billing-header"))).toBe(true)
    expect(systemTexts.some((t) => t.startsWith(SYSTEM_IDENTITY_PREFIX))).toBe(true)
    // Relocated content is prepended to the first user message.
    const messages = result["messages"] as Array<{ content: Array<Record<string, unknown>> }>
    const firstUserContent = messages[0]!.content
    expect(firstUserContent[0]!["type"]).toBe("text")
    expect(firstUserContent[0]!["text"]).toContain("third-party system instructions")
    expect(firstUserContent[0]!["text"]).toContain("additional rules")
    // Original user text survives at the tail.
    expect(firstUserContent[1]!["text"]).toBe("hello")
  })

  test("relocates into a string-content user message", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [{ type: "text", text: "third-party prefix" }],
      messages: [{ role: "user", content: "hello" }],
    }
    const result = transformPayload(payload)
    const messages = result["messages"] as Array<{ content: string }>
    expect(messages[0]!.content).toContain("third-party prefix")
    expect(messages[0]!.content.endsWith("hello")).toBe(true)
  })

  test("leaves system unchanged when there are no third-party blocks", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }
    const result = transformPayload(payload)
    const system = result["system"] as Array<{ text?: string }>
    // billing + identity only — no extras to move.
    expect(system).toHaveLength(2)
    const messages = result["messages"] as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages[0]!.content).toHaveLength(1)
  })
})

// ── haiku effort-strip (counsel C7 / opencode parity C) ──

describe("transformPayload — haiku effort-strip", () => {
  test("strips output_config.effort when model starts with claude-haiku", () => {
    const payload = {
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" as const },
    }
    const result = transformPayload(payload)
    expect(result["output_config"]).toBeUndefined()
  })

  test("preserves other output_config keys when stripping effort", () => {
    const payload = {
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" as const, other: 123 },
    }
    const result = transformPayload(payload)
    const oc = result["output_config"] as { effort?: string; other?: number }
    expect(oc.effort).toBeUndefined()
    expect(oc.other).toBe(123)
  })

  test("leaves output_config.effort intact for non-haiku models", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" as const },
    }
    const result = transformPayload(payload)
    const oc = result["output_config"] as { effort?: string }
    expect(oc.effort).toBe("high")
  })
})
