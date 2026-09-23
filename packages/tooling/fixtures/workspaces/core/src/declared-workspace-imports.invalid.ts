// Core declares no workspace dependency, so every read of the SDK is an
// undeclared edge, and a relative path into the SDK leaves core's root.
import { Gent } from "@gent/sdk"
import type { GentServer } from "@gent/sdk"
import {
  Multi,
} from
  "@gent/sdk"
import { helper } from "../../sdk/src/helper"
export { Gent as Again } from "@gent/sdk"
export * from "@gent/sdk/client"

export const lazy = import("@gent/sdk")
export const loaded = require("@gent/sdk")
export type Client = typeof import("@gent/sdk")
export const used = [Gent, Multi, helper] satisfies ReadonlyArray<unknown>
export type Server = GentServer
