import { Match, Schema } from "effect"

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
}

export const MermaidViewerEvent = Schema.TaggedUnion({
  Open: {},
  PanLeft: { step: Schema.Finite },
  PanRight: { step: Schema.Finite },
  PanUp: { step: Schema.Finite },
  PanDown: { step: Schema.Finite },
  PrevDiagram: {},
  NextDiagram: { diagramCount: Schema.Finite },
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
  const transitionEvent: (event: MermaidViewerEvent) => MermaidViewerState =
    Match.type<MermaidViewerEvent>().pipe(
      Match.tagsExhaustive({
        Open: () => MermaidViewerState.initial(),
        PanLeft: (event) => ({
          ...state,
          panX: Math.max(0, state.panX - event.step),
        }),
        PanRight: (event) => ({
          ...state,
          panX: state.panX + event.step,
        }),
        PanUp: (event) => ({
          ...state,
          panY: Math.max(0, state.panY - event.step),
        }),
        PanDown: (event) => ({
          ...state,
          panY: state.panY + event.step,
        }),
        PrevDiagram: () =>
          resetPan({
            ...state,
            diagramIndex: Math.max(0, state.diagramIndex - 1),
          }),
        NextDiagram: (event) =>
          resetPan({
            ...state,
            diagramIndex: Math.min(event.diagramCount - 1, state.diagramIndex + 1),
          }),
        ResetPan: () => resetPan(state),
      }),
    )
  return transitionEvent(event)
}
