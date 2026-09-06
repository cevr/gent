/**
 * Environment context — env vars read via Effect Config at startup,
 * threaded to components via Solid context.
 */

import { createContext } from "solid-js"
import type { JSX } from "solid-js"
import type * as Option from "effect/Option"
import { useRequiredContext } from "../utils/solid-context"

export interface EnvContextValue {
  /** $VISUAL editor */
  visual: Option.Option<string>
  /** $EDITOR editor */
  editor: Option.Option<string>
  /** Graceful shutdown — triggers Effect scope cleanup instead of process.exit */
  shutdown: () => void
}

const EnvContext = createContext<EnvContextValue>()

export function useEnv(): EnvContextValue {
  return useRequiredContext(EnvContext, "useEnv must be used within EnvProvider")
}

interface EnvProviderProps {
  env: EnvContextValue
  children: JSX.Element
}

export function EnvProvider(props: EnvProviderProps) {
  return <EnvContext.Provider value={props.env}>{props.children}</EnvContext.Provider>
}
