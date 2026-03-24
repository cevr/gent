/**
 * Builtin TUI client extension — registers all builtin tool renderers.
 *
 * Dogfooding entry point: builtins go through the same resolveTuiExtensions()
 * pipeline as user/project extensions.
 *
 * Widget migration happens in batch 5 once widget slots are wired into session.tsx.
 */

import type { ExtensionClientModule } from "@gent/core/domain/extension-client.js"
import type { ToolRenderer } from "../components/tool-renderers/types"
import { BUILTIN_TOOL_RENDERERS } from "../components/tool-renderers/index"

export const BUILTIN_CLIENT_EXTENSION: ExtensionClientModule<ToolRenderer> = {
  id: "@gent/builtin",
  setup: () => ({
    tools: BUILTIN_TOOL_RENDERERS,
  }),
}
