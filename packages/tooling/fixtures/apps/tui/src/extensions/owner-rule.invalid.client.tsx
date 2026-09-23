// @ts-nocheck — fixture file
// EXPECTED: rule `gent/core-entry-boundary` fires on every relative import
// of a TUI module other than a sibling client extension (8 total): the
// client provider, the extension host, a host utility, the facet module by
// path, a type import, a re-export, a dynamic import and `typeof import`.
import { useClient } from "../client"
import { useExtensionUI } from "./host.tsx"
import { truncate } from "../utils"
import { clientCommandContribution } from "./client-facets"
import type { ToolRenderer } from "../tool-renderers"
import { defineClientExtension } from "@gent/tui/extensions"
export { useTheme } from "../theme"
export const loadSession = () => import("../session")
export type Commands = typeof import("../commands")
export const values = [useClient, useExtensionUI, truncate, clientCommandContribution]
export type Renderer = ToolRenderer
export default defineClientExtension("fixture/owner-rule", {})
