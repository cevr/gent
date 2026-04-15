import { extension } from "../api.js"
import { DelegateTool } from "./delegate-tool.js"

export const DelegateExtension = extension("@gent/delegate", ({ ext }) => ext.tools(DelegateTool))
