import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { BUILTIN_TOOL_RENDERERS } from "../../components/tool-renderers/index"

export default defineClientExtension({
  id: "@gent/tools",
  setup: () => ({
    tools: BUILTIN_TOOL_RENDERERS,
  }),
})
