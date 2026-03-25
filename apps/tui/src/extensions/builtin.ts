/**
 * Builtin TUI client extension — registers all builtin tool renderers and widgets.
 *
 * Dogfooding entry point: builtins go through the same resolveTuiExtensions()
 * pipeline as user/project extensions.
 */

import type { ExtensionClientModule } from "@gent/core/domain/extension-client.js"
import type { ToolRenderer } from "../components/tool-renderers/types"
import { BUILTIN_TOOL_RENDERERS } from "../components/tool-renderers/index"
import { PlanModeWidget } from "./plan-mode-widget"

export const BUILTIN_CLIENT_EXTENSION: ExtensionClientModule<ToolRenderer> = {
  id: "@gent/builtin",
  setup: () => ({
    tools: BUILTIN_TOOL_RENDERERS,
    widgets: [
      {
        id: "plan-mode",
        slot: "above-input",
        priority: 10,
        component: PlanModeWidget,
      },
    ],
  }),
}
