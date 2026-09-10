import type { GentExtension } from "@gent/core/extensions/api"
import { BuiltinExtensions, CellBranchTools } from "@gent/extensions"

/**
 * The shipped composition: the `cell` surface plus every builtin. The embedded
 * SDK server and `apps/server` compose this same list so the model sees one
 * surface everywhere.
 */
export const ShippedExtensions: ReadonlyArray<GentExtension> = BuiltinExtensions

/**
 * The branch-tool feature the shipped composition installs.
 *
 * `CellExtension` gives the model the `cell` surface; this gives the loop the
 * storage and per-branch kernel that surface runs on. A root passing one
 * without the other gets a `cell` tool that fails on first use, so they are
 * named side by side.
 */
export const ShippedBranchTools = CellBranchTools
