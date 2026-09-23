// The SDK declares core, may name itself, and reads its own files by relative
// path. A module named in a comment, a string or a template is not an import.
import { GentRpcs } from "@gent/core/protocol"
import type { Gent } from "@gent/sdk"
import { own } from "./own"

// import { Extension } from "@gent/extensions"
/* import { Extension } from "@gent/extensions" */
export const example = 'import { Extension } from "@gent/extensions"'
export const shown = `import { Extension } from "@gent/extensions" ${own}`
export const pattern = /["']/
export const used = [GentRpcs, own] satisfies ReadonlyArray<unknown>
export type Client = Gent
