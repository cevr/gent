// @ts-nocheck — fixture file
// EXPECTED: rule `gent/core-entry-boundary` does NOT fire: the builtin roster
// names its sibling client extensions by relative path and reaches the rest
// of the TUI through `@gent/tui/extensions`.
import { SessionId } from "@gent/core/protocol"
import { defineClientExtension } from "@gent/tui/extensions"
import agents from "./agents.client"
import btw from "./btw.client.tsx"
export const builtinClientModules = [agents, btw]
export const values = [SessionId, defineClientExtension]
