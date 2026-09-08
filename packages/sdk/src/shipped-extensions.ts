import type { GentExtension } from "@gent/core/extensions/api"
import { CellExtension } from "@gent/core-internal/runtime/code-cell/cell-extension.js"
import { BuiltinExtensions } from "@gent/extensions"

/**
 * The shipped composition: the `cell` surface plus every builtin. The embedded
 * SDK server and `apps/server` compose this same list so the model sees one
 * surface everywhere.
 */
export const ShippedExtensions: ReadonlyArray<GentExtension> = [CellExtension, ...BuiltinExtensions]
