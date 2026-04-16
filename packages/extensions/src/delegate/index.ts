import { extension } from "@gent/core/extensions/api"
import { DelegateTool } from "./delegate-tool.js"

export const DelegateExtension = extension("@gent/delegate", ({ ext }) => ext.tools(DelegateTool))
