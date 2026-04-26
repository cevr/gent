/**
 * Driver routing UI — `/driver` slash command.
 *
 * Two forms:
 *   - `/driver <agent> <driverId>`  → set per-agent runtime override
 *   - `/driver <agent> default|clear` → remove the override
 *   - `/driver` (no args)            → emit a status hint message
 *
 * Validation lives server-side: `driver.set` rejects unknown driver ids
 * with `NotFoundError`. The TUI surfaces the failure as an inline status
 * message rather than a modal — same UX as `/clear` etc.
 *
 * This contribution is delivered by a core builtin (not by the
 * `@gent/acp-agents` extension) so the slash remains available even when
 * the ACP extension is disabled — useful for clearing a stale override.
 */

import { Effect } from "effect"
import { defineClientExtension, clientCommandContribution } from "../client-facets.js"
import { AgentName, ExternalDriverRef, ModelDriverRef } from "@gent/core/domain/agent.js"
import { ClientShell } from "../client-services"
import { ClientTransport } from "../client-transport"

const USAGE = "Usage: /driver <agent> <driver-id|default>"

export default defineClientExtension("@gent/driver-ui", {
  setup: Effect.gen(function* () {
    const shell = yield* ClientShell
    const { client, runtime } = yield* ClientTransport
    return [
      clientCommandContribution({
        id: "driver.route",
        title: "Driver routing",
        description: "Set or clear a per-agent driver override",
        category: "Driver",
        slash: "driver",
        onSelect: () => {
          shell.sendMessage(USAGE)
        },
        onSlash: (args) => {
          const trimmed = args.trim()
          if (trimmed.length === 0) {
            shell.sendMessage(USAGE)
            return
          }
          const parts = trimmed.split(/\s+/)
          if (parts.length !== 2) {
            shell.sendMessage(USAGE)
            return
          }
          const rawAgentName = parts[0]
          const driverArg = parts[1]
          if (rawAgentName === undefined || driverArg === undefined) {
            shell.sendMessage(USAGE)
            return
          }
          const agentName = AgentName.make(rawAgentName)
          if (driverArg === "default" || driverArg === "clear") {
            void runtime
              .run(client.driver.clear({ agentName }))
              .then(() => {
                shell.sendMessage(`Cleared driver override for "${agentName}".`)
              })
              .catch((err: unknown) => {
                shell.sendMessage(`Failed to clear driver override: ${String(err)}`)
              })
            return
          }
          void runtime
            .run(
              Effect.gen(function* () {
                const { drivers } = yield* client.driver.list()
                const matches = drivers.filter((driver) => driver.id === driverArg)
                if (matches.length === 0) {
                  shell.sendMessage(`Unknown driver "${driverArg}".`)
                  return false
                }
                if (matches.length > 1) {
                  shell.sendMessage(`Ambiguous driver "${driverArg}".`)
                  return false
                }
                const [match] = matches
                if (match === undefined) return false
                const driver =
                  match._tag === "external"
                    ? ExternalDriverRef.make({ id: match.id })
                    : ModelDriverRef.make({ id: match.id })
                yield* client.driver.set({ agentName, driver })
                return true
              }),
            )
            .then((changed) => {
              if (changed) shell.sendMessage(`Set "${agentName}" → driver "${driverArg}".`)
            })
            .catch((err: unknown) => {
              shell.sendMessage(`Failed to set driver: ${String(err)}`)
            })
        },
      }),
    ]
  }),
})
