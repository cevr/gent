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

export type MermaidViewerEvent =
  | { readonly _tag: "Open" }
  | { readonly _tag: "PanLeft"; readonly step: number }
  | { readonly _tag: "PanRight"; readonly step: number }
  | { readonly _tag: "PanUp"; readonly step: number }
  | { readonly _tag: "PanDown"; readonly step: number }
  | { readonly _tag: "PrevDiagram" }
  | { readonly _tag: "NextDiagram"; readonly diagramCount: number }
  | { readonly _tag: "ResetPan" }

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
