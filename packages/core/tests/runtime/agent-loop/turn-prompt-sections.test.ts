import { describe, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "@gent/core-internal/domain/agent"
import { tool } from "@gent/core-internal/domain/capability/tool"
import { buildTurnPromptSections } from "@gent/core-internal/runtime/agent/agent-loop.utils"
import { CellTool } from "@gent/core-internal/runtime/code-cell/cell-tool"

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
const delegate = tool({
  id: "delegate",
  description: "Delegate a todo to a child.",
  params: Schema.Struct({
    todo: Schema.String,
    description: Schema.optionalKey(Schema.String),
    background: Schema.optional(Schema.Boolean),
  }),
  output: Schema.String,
  execute: () => Effect.succeed(""),
})
const agent = new AgentDefinition({ name: DEFAULT_AGENT_NAME })

describe("turn prompt sections", () => {
  it.effect("tells the model what the cell runtime exposes so it does not guess at imports", () =>
    Effect.sync(() => {
      const sections = buildTurnPromptSections([], agent, [CellTool], [], [CellTool, read])
      const guidelines = sections.find((section) => section.id === "tool-guidelines")
      expect(guidelines?.content).toContain(
        "- The cell is a Bun runtime in the working directory: Bun (Bun.file, Bun.$, Bun.spawn), fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory.",
      )
      expect(guidelines?.content).toContain(
        "- console output during the cell returns with its result.",
      )
    }),
  )

  it.effect("lists host tools callable inside the cell as one instruction section", () =>
    Effect.sync(() => {
      const sections = buildTurnPromptSections([], agent, [cell], [], [write, cell, read])
      const catalog = sections.find((section) => section.id === "cell-catalog")
      expect(catalog?.content).toContain("## Host Tools")
      expect(catalog?.content).toContain(
        "- **read**(path): Read a file\n- **write**(path, content): Write a file to disk.",
      )
      expect(catalog?.content).not.toContain("- **cell**")
      // The narrowed surface keeps the model tool list to the cell alone.
      expect(sections.find((section) => section.id === "tool-list")).toBeUndefined()
    }),
  )

  it.effect("marks optional input keys so the model does not guess the input shape", () =>
    Effect.sync(() => {
      const sections = buildTurnPromptSections([], agent, [cell], [], [cell, delegate])
      const catalog = sections.find((section) => section.id === "cell-catalog")
      expect(catalog?.content).toContain(
        "- **delegate**(todo, description?, background?): Delegate a todo to a child.",
      )
    }),
  )

  it.effect("adds no catalog section when the model surface was not narrowed to the cell", () =>
    Effect.sync(() => {
      const sections = buildTurnPromptSections([], agent, [read, write], [])
      expect(sections.find((section) => section.id === "cell-catalog")).toBeUndefined()
    }),
  )
})
