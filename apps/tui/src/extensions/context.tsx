/**
 * ExtensionUIProvider — Solid context for resolved TUI extensions.
 *
 * Loads on mount: discovers *.client.* files, imports them, resolves with scope precedence.
 * Provides resolved contributions to descendants.
 */

import { createContext, useContext, createSignal, onMount, type Accessor, type JSX } from "solid-js"
// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { Command } from "../command/types"
import type { ResolvedTuiExtensions, ResolvedWidget } from "./resolve"
import { loadTuiExtensions } from "./loader"
import { useWorkspace } from "../workspace/index"

export interface ExtensionUIContextValue {
  readonly renderers: Accessor<Map<string, ToolRenderer>>
  readonly widgets: Accessor<ReadonlyArray<ResolvedWidget>>
  readonly commands: Accessor<ReadonlyArray<Command>>
  readonly overlays: Accessor<Map<string, ToolRenderer>>
  readonly loading: Accessor<boolean>
}

const EMPTY_RESOLVED: ResolvedTuiExtensions = {
  renderers: new Map(),
  widgets: [],
  commands: [],
  overlays: new Map(),
}

const ExtensionUIContext = createContext<ExtensionUIContextValue>()

export function ExtensionUIProvider(props: { children: JSX.Element }) {
  const workspace = useWorkspace()
  const [resolved, setResolved] = createSignal<ResolvedTuiExtensions>(EMPTY_RESOLVED)
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      const home = homedir()
      const result = await loadTuiExtensions(
        {
          userDir: `${home}/.gent/extensions`,
          projectDir: `${workspace.cwd}/.gent/extensions`,
        },
        {
          // Overlay dispatch stubs — wired to session UI state in batch 5
          openOverlay: () => {},
          closeOverlay: () => {},
        },
      )
      setResolved(result)
    } catch (err) {
      console.log(`[tui-ext] Extension loading failed: ${err}`)
    } finally {
      setLoading(false)
    }
  })

  return (
    <ExtensionUIContext.Provider
      value={{
        renderers: () => resolved().renderers,
        widgets: () => resolved().widgets,
        commands: () => resolved().commands,
        overlays: () => resolved().overlays,
        loading,
      }}
    >
      {props.children}
    </ExtensionUIContext.Provider>
  )
}

export function useExtensionUI(): ExtensionUIContextValue {
  const ctx = useContext(ExtensionUIContext)
  if (ctx === undefined) throw new Error("useExtensionUI must be used within ExtensionUIProvider")
  return ctx
}
