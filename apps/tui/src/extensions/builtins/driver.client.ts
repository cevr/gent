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

import { Effect, Option } from "effect"
import { defineClientExtension, clientCommandContribution } from "../client-facets.js"
import { AgentName, ExternalDriverRef, ModelDriverRef } from "@gent/core-internal/domain/agent.js"
import { ClientDriver, ClientShell } from "../client-services"

const USAGE = "Usage: /driver <agent> <driver-id|default>"

export default defineClientExtension("@gent/driver-ui", {
  setup: Effect.gen(function* () {
    const shell = yield* ClientShell
    const driverClient = yield* ClientDriver
    return clientCommandContribution({
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
        const rawAgentName = Option.fromNullishOr(parts[0])
        const driverArg = Option.fromNullishOr(parts[1])
        if (Option.isNone(rawAgentName) || Option.isNone(driverArg)) {
          shell.sendMessage(USAGE)
          return
        }
        const agentName = AgentName.make(rawAgentName.value)
        if (driverArg.value === "default" || driverArg.value === "clear") {
          void shell
            .run(driverClient.clear({ agentName }))
            .then(() => {
              shell.sendMessage(`Cleared driver override for "${agentName}".`)
            })
            .catch((err) => {
              shell.sendMessage(`Failed to clear driver override: ${String(err)}`)
            })
          return
        }
        void shell
          .run(
            Effect.gen(function* () {
              const { drivers } = yield* driverClient.list
              const matches = drivers.filter((driver) => driver.id === driverArg.value)
              if (matches.length === 0) {
                shell.sendMessage(`Unknown driver "${driverArg.value}".`)
                return false
              }
              if (matches.length > 1) {
                shell.sendMessage(`Ambiguous driver "${driverArg.value}".`)
                return false
              }
              const match = Option.fromNullishOr(matches[0])
              if (Option.isNone(match)) return false
              const driver = (() => {
                if (match.value._tag === "external") {
                  return ExternalDriverRef.make({ id: match.value.id })
                }
                return ModelDriverRef.make({ id: match.value.id })
              })()
              yield* driverClient.set({ agentName, driver })
              return true
            }),
          )
          .then((changed) => {
            if (changed) shell.sendMessage(`Set "${agentName}" → driver "${driverArg.value}".`)
          })
          .catch((err) => {
            shell.sendMessage(`Failed to set driver: ${String(err)}`)
          })
      },
    })
  }),
})
