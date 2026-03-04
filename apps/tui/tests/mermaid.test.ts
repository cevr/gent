import { describe, test, expect } from "bun:test"
import { extractMermaidBlocks } from "../src/utils/mermaid"

describe("extractMermaidBlocks", () => {
  test("extracts single block with correct source/startIndex/endIndex", () => {
    const text = "before\n```mermaid\ngraph TD\n  A-->B\n```\nafter"
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.source).toBe("graph TD\n  A-->B")
    expect(blocks[0]!.startIndex).toBe(7)
    expect(blocks[0]!.endIndex).toBe(text.indexOf("```\n") + 3)
  })

  test("extracts multiple blocks", () => {
    const text = [
      "intro",
      "```mermaid",
      "graph LR",
      "  A-->B",
      "```",
      "middle",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: msg",
      "```",
      "end",
    ].join("\n")
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(2)
    expect(blocks[0]!.source).toBe("graph LR\n  A-->B")
    expect(blocks[1]!.source).toBe("sequenceDiagram\n  A->>B: msg")
  })

  test("returns [] for no mermaid blocks", () => {
    expect(extractMermaidBlocks("no mermaid here")).toEqual([])
    expect(extractMermaidBlocks("```typescript\nconst x = 1\n```")).toEqual([])
  })

  test("skips empty mermaid blocks", () => {
    const text = "```mermaid\n\n```"
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(0)
  })

  test("handles whitespace before content", () => {
    const text = "```mermaid\n  \n  graph TD\n    A-->B\n```"
    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.source).toBe("graph TD\n    A-->B")
  })

  test("correct indices for replaceMermaidBlocks composition", () => {
    const prefix = "Hello\n"
    const mermaid = "```mermaid\ngraph TD\n  A-->B\n```"
    const suffix = "\nGoodbye"
    const text = prefix + mermaid + suffix

    const blocks = extractMermaidBlocks(text)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.startIndex).toBe(prefix.length)
    expect(blocks[0]!.endIndex).toBe(prefix.length + mermaid.length)
    // Verify slicing roundtrip
    expect(text.slice(blocks[0]!.startIndex, blocks[0]!.endIndex)).toBe(mermaid)
  })
})
