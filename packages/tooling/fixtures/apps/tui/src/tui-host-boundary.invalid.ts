// The TUI host reads no extension module, by any subpath or form.
import { DelegateRpc } from "@gent/extensions/client.js"
import type { DelegateChild } from "@gent/extensions/client"
export { SkillsRpc } from "@gent/extensions"

export const load = () => import("@gent/extensions/client")

export type Row = DelegateChild
export const rpc = DelegateRpc
