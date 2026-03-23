import { describe, expect, test } from "bun:test"
import { MermaidViewerState, transitionMermaidViewer } from "../src/components/mermaid-viewer-state"

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
