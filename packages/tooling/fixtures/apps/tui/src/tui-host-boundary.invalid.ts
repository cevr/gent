// The TUI host reads no extension module, by any subpath or form.
import { GoalRpc } from "@gent/extensions/client.js"
import type { GoalSnapshot } from "@gent/extensions/client"
export { SkillsRpc } from "@gent/extensions"

export const load = () => import("@gent/extensions/client")

export type Row = GoalSnapshot
export const rpc = GoalRpc
