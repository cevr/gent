import { Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

export interface MermaidViewerState {
  readonly diagramIndex: number
  readonly panX: number
  readonly panY: number
}

export const MermaidViewerState = {
  initial: (): MermaidViewerState => ({
    diagramIndex: 0,
    panX: 0,
    panY: 0,
  }),
} as const

export const MermaidViewerEvent = TaggedEnumClass("MermaidViewerEvent", {
  Open: {},
  PanLeft: { step: Schema.Number },
  PanRight: { step: Schema.Number },
  PanUp: { step: Schema.Number },
  PanDown: { step: Schema.Number },
  PrevDiagram: {},
  NextDiagram: { diagramCount: Schema.Number },
  ResetPan: {},
})
export type MermaidViewerEvent = Schema.Schema.Type<typeof MermaidViewerEvent>

const resetPan = (state: MermaidViewerState): MermaidViewerState => ({
  ...state,
  panX: 0,
  panY: 0,
})

export function transitionMermaidViewer(
  state: MermaidViewerState,
  event: MermaidViewerEvent,
): MermaidViewerState {
  switch (event._tag) {
    case "Open":
      return MermaidViewerState.initial()
    case "PanLeft":
      return {
        ...state,
        panX: Math.max(0, state.panX - event.step),
      }
    case "PanRight":
      return {
        ...state,
        panX: state.panX + event.step,
      }
    case "PanUp":
      return {
        ...state,
        panY: Math.max(0, state.panY - event.step),
      }
    case "PanDown":
      return {
        ...state,
        panY: state.panY + event.step,
      }
    case "PrevDiagram":
      return resetPan({
        ...state,
        diagramIndex: Math.max(0, state.diagramIndex - 1),
      })
    case "NextDiagram":
      return resetPan({
        ...state,
        diagramIndex: Math.min(event.diagramCount - 1, state.diagramIndex + 1),
      })
    case "ResetPan":
      return resetPan(state)
  }
}
