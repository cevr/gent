/**
 * Client extension authoring API — the `@gent/tui/extensions` entry.
 *
 * A `*.client.ts(x)` file in `~/.gent/extensions/` or `.gent/extensions/`
 * default-exports `defineClientExtension(id, { setup })`. `setup` is an Effect
 * that may yield `ClientContext` and answers the extension's contributions.
 *
 * Every shipped client extension imports the TUI through this entry and
 * nothing else, so a user extension can reach everything a shipped one can.
 * A name belongs here only when a shipped extension uses it.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { clientCommandContribution, ClientContext, defineClientExtension } from "@gent/tui/extensions"
 *
 * export default defineClientExtension("@me/hello", {
 *   setup: Effect.gen(function* () {
 *     const ctx = yield* ClientContext
 *     return clientCommandContribution({
 *       id: "hello",
 *       title: "Say hello",
 *       onSelect: () => ctx.shell.notify("hello"),
 *     })
 *   }),
 * })
 * ```
 *
 * @module
 */

// ── authoring surface ──

export {
  type ActiveExtensionSession,
  type AnyExtensionClientModule,
  autocompleteContribution,
  type ClientActivitySnapshot,
  clientCommandContribution,
  clientContributions,
  ClientContext,
  coalescedRead,
  defineClientExtension,
  type ExtensionAgentDetail,
  interactionRendererContribution,
  messageRendererContribution,
  type MessageRowProps,
  type NoticeRow,
  noticeRowContribution,
  rendererContribution,
  sessionQuery,
  statusLabelContribution,
  widgetContribution,
} from "./extensions/client-facets.js"

// ── rendering kit ──

export {
  ChromePanel,
  CollapsedRow,
  decoration,
  PickerFrame,
  selectable,
  SelectList,
  type SelectListApi,
  type SelectListRow,
  ToolFrame,
  TrayFrame,
  usePickerGeometry,
  UserRow,
  useSpinnerClock,
} from "./ui"
export { useTheme } from "./theme"
export { pastedLine, typedText, useScopedKeyboard, useTerminalDimensions } from "./terminal"
export { textWidth } from "./text-width-adapter"
export {
  fitWidth,
  formatAge,
  formatDuration,
  formatFileRef,
  formatTokens,
  formatUsageStats,
  isReferenceablePath,
  plural,
  shortId,
  type ToolInput,
  truncate,
  truncatePath,
  workingIconFrame,
} from "./utils"

// ── shipped renderers and ranking ──

export { BUILTIN_TOOL_RENDERERS, type ToolRendererProps } from "./tool-renderers"
export { AskUserRenderer, HandoffRenderer, PromptRenderer } from "./interaction-renderers"
export { rankAutocompleteItems, readFrecencyLookup, recordFrecencyPick } from "./autocomplete"
