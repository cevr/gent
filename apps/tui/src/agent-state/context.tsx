import { createContext, useContext, type JSX, type Accessor, type Setter } from "solid-js"
import { createSignal } from "solid-js"
import type { AgentMode } from "@gent/core"

export type AgentStatus = "idle" | "streaming" | "error"

interface AgentStateContextValue {
  mode: Accessor<AgentMode>
  setMode: Setter<AgentMode>
  status: Accessor<AgentStatus>
  setStatus: Setter<AgentStatus>
  cost: Accessor<number>
  setCost: Setter<number>
  addCost: (amount: number) => void
  error: Accessor<string | null>
  setError: Setter<string | null>
}

const AgentStateContext = createContext<AgentStateContextValue>()

export function useAgentState(): AgentStateContextValue {
  const ctx = useContext(AgentStateContext)
  if (!ctx) throw new Error("useAgentState must be used within AgentStateProvider")
  return ctx
}

interface AgentStateProviderProps {
  children: JSX.Element
}

export function AgentStateProvider(props: AgentStateProviderProps) {
  const [mode, setMode] = createSignal<AgentMode>("build")
  const [status, setStatus] = createSignal<AgentStatus>("idle")
  const [cost, setCost] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)

  const addCost = (amount: number) => setCost((prev) => prev + amount)

  const value: AgentStateContextValue = {
    mode,
    setMode,
    status,
    setStatus,
    cost,
    setCost,
    addCost,
    error,
    setError,
  }

  return (
    <AgentStateContext.Provider value={value}>
      {props.children}
    </AgentStateContext.Provider>
  )
}
