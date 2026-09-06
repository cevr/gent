/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions as useRendererTerminalDimensions } from "@opentui/solid"
import { Option } from "effect"
import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"

export interface TerminalDimensions {
  readonly width: number
  readonly height: number
}

const TerminalDimensionsContext = createContext<Option.Option<Accessor<TerminalDimensions>>>(
  Option.none(),
)

export function TerminalDimensionsProvider(props: ParentProps) {
  const dimensions = useRendererTerminalDimensions()
  return (
    <TerminalDimensionsContext.Provider value={Option.some(dimensions)}>
      {props.children}
    </TerminalDimensionsContext.Provider>
  )
}

export const useTerminalDimensions = (): Accessor<TerminalDimensions> =>
  Option.getOrThrow(useContext(TerminalDimensionsContext))
