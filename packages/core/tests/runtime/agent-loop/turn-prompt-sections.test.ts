import { describe, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "../../../src/domain/agent"
import { tool } from "../../../src/domain/capability/tool"
import { buildTurnPromptSections } from "../../../src/runtime/agent/agent-loop.utils"
import { CellTool } from "../../../src/runtime/code-cell/cell-tool"

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
  it.effect("tells the model what the cell runtime exposes so it does not guess at imports", () =>
    Effect.sync(() => {
      const sections = buildTurnPromptSections([], agent, [CellTool], [])
      const guidelines = sections.find((section) => section.id === "tool-guidelines")
      expect(guidelines?.content).toContain(
        "- The cell is a Bun runtime in the working directory: Bun (Bun.file, Bun.$, Bun.spawn), fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory.",
      )
      expect(guidelines?.content).toContain(
        "- console output, process.stdout and process.stderr writes, and inherited output of spawned processes return with the cell result",
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
