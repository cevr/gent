/**
 * Environment context — env vars read via Effect Config at startup,
 * threaded to components via Solid context.
 */

import { createContext, useContext } from "solid-js"
import type { JSX } from "solid-js"

export interface EnvContextValue {
  /** $VISUAL editor */
  visual: string | undefined
  /** $EDITOR editor */
  editor: string | undefined
}

const EnvContext = createContext<EnvContextValue>()

export function useEnv(): EnvContextValue {
  const ctx = useContext(EnvContext)
  if (ctx === undefined) throw new Error("useEnv must be used within EnvProvider")
  return ctx
}

interface EnvProviderProps {
  env: EnvContextValue
  children: JSX.Element
}

export function EnvProvider(props: EnvProviderProps) {
  return <EnvContext.Provider value={props.env}>{props.children}</EnvContext.Provider>
}
