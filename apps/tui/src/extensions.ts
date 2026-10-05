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
  type InteractionRendererProps,
  messageRendererContribution,
  type MessageRowProps,
  type NoticeRow,
  noticeRowContribution,
  type QueuedMessage,
  rendererContribution,
  sessionQuery,
  STATUS_YIELD,
  statusLabelContribution,
  type StatusLabelItem,
  stoppableContribution,
  widgetContribution,
} from "./extensions/client-facets.js"

// ── rendering kit ──

export {
  AgentMessageRow,
  ChromePanel,
  CollapsedRow,
  type CollapsedRowProps,
  decoration,
  groupedRows,
  keyHint,
  KeyHints,
  lineEdit,
  PickerFrame,
  plainRow,
  selectable,
  SelectList,
  type SelectListRow,
  ToolFrame,
  TrayFrame,
  usePickerGeometry,
  UserRow,
  useSpinnerClock,
} from "./ui"
export { useTheme } from "./theme"
export { pastedLine, typedKey, useScopedKeyboard, useTerminalDimensions } from "./terminal"
export { textWidth } from "./bun-adapter"
export {
  type ActivityCall,
  type ActivityOperation,
  activityRows,
  displayPath,
  fitWidth,
  formatActivityHeader,
  formatActivityRow,
  formatAge,
  formatClock,
  formatCost,
  formatDuration,
  formatFileRef,
  formatPreviewFooter,
  formatTokens,
  formatUsageStats,
  isReferenceablePath,
  type PathPlace,
  plural,
  repliesInView,
  type ReplyWriter,
  runningCallLabel,
  shortId,
  type ToolInput,
  truncate,
  truncatePath,
  workingIconFrame,
} from "./utils"

// ── shipped renderers and ranking ──

export { BUILTIN_TOOL_RENDERERS, failureReason, type ToolRendererProps } from "./tool-renderers"
export { HandoffRenderer, OptionList, PromptRenderer, yesNoAnswer } from "./interaction-renderers"
export { rankAutocompleteItems, readFrecencyLookup, recordFrecencyPick } from "./autocomplete"
