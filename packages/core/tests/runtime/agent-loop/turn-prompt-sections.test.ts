import { describe, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "@gent/core-internal/domain/agent"
import { tool } from "@gent/core-internal/domain/capability/tool"
import { buildTurnPromptSections } from "@gent/core-internal/runtime/agent/agent-loop.utils"

const cell = tool({
  id: "cell",
  description: "Run TypeScript in the persistent cell.",
  params: Schema.Struct({ code: Schema.String }),
  output: Schema.String,
  execute: () => Effect.succeed(""),
})
const read = tool({
  id: "read",
  description: "Read a file from disk.",
  promptSnippet: "Read a file",
  params: Schema.Struct({ path: Schema.String }),
  output: Schema.String,
  execute: () => Effect.succeed(""),
})
const write = tool({
  id: "write",
  description: "Write a file to disk.",
  params: Schema.Struct({ path: Schema.String, content: Schema.String }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})
const agent = new AgentDefinition({ name: DEFAULT_AGENT_NAME })

describe("turn prompt sections", () => {
  it.effect("lists host tools callable inside the cell as one instruction section", () =>
    Effect.sync(() => {
      const sections = buildTurnPromptSections([], agent, [cell], [], [], [write, cell, read])
      const catalog = sections.find((section) => section.id === "cell-catalog")
      expect(catalog?.content).toContain("## Host Tools")
      expect(catalog?.content).toContain(
        "- **read**: Read a file\n- **write**: Write a file to disk.",
      )
      expect(catalog?.content).not.toContain("- **cell**")
      // The narrowed surface keeps the model tool list to the cell alone.
      expect(sections.find((section) => section.id === "tool-list")).toBeUndefined()
    }),
  )

  it.effect("adds no catalog section when the model surface was not narrowed to the cell", () =>
    Effect.sync(() => {
      const sections = buildTurnPromptSections([], agent, [read, write], [], [])
      expect(sections.find((section) => section.id === "cell-catalog")).toBeUndefined()
    }),
  )
})
