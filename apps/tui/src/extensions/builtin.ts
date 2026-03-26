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
import { TaskWidget } from "../components/task-widget"
import { ConnectionWidget } from "../components/connection-widget"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ToolRenderer | ((props?: any) => any)

export const BUILTIN_CLIENT_EXTENSION: ExtensionClientModule<AnyComponent> = {
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
      {
        id: "tasks",
        slot: "below-messages",
        priority: 20,
        component: TaskWidget,
      },
      {
        id: "connection",
        slot: "below-messages",
        priority: 30,
        component: ConnectionWidget,
      },
    ],
  }),
}
