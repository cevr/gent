import { describe, expect, test } from "effect-bun-test"
import { extractMermaidBlocks, MermaidViewerState, transitionMermaidViewer } from "../src/mermaid"

// ── mermaid.test ────────────────────────────────────────────────────────────

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

// ── mermaid-viewer-state.test ───────────────────────────────────────────────

describe("transitionMermaidViewer", () => {
  test("open resets viewer state", () => {
    const state = transitionMermaidViewer(
      {
        diagramIndex: 2,
        panX: 40,
        panY: 12,
      },
      { _tag: "Open" },
    )

    expect(state).toEqual(MermaidViewerState.initial())
  })

  test("panning clamps left and up at zero", () => {
    const state = transitionMermaidViewer(
      {
        diagramIndex: 0,
        panX: 2,
        panY: 1,
      },
      { _tag: "PanLeft", step: 10 },
    )
    const up = transitionMermaidViewer(state, { _tag: "PanUp", step: 5 })

    expect(state.panX).toBe(0)
    expect(up.panY).toBe(0)
  })

  test("changing diagrams resets pan", () => {
    const next = transitionMermaidViewer(
      {
        diagramIndex: 0,
        panX: 30,
        panY: 8,
      },
      { _tag: "NextDiagram", diagramCount: 3 },
    )

    expect(next).toEqual({
      diagramIndex: 1,
      panX: 0,
      panY: 0,
    })
  })
})
