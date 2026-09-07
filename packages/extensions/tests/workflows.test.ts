/**
 * Workflow commands RPC acceptance test. Each slash command queues a recipe
 * prompt that runs as a model turn through the per-request scope.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { WORKFLOWS_EXTENSION_ID } from "../src/workflows.js"
import { e2ePreset } from "./helpers/test-preset"

describe("WorkflowsExtension via RPC", () => {
  it.live(
    "slash commands are listed and /plan queues a recipe over host tools",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const commands = yield* client.extension.listSlashCommands({ sessionId })
          const workflowCommands = commands.filter(
            (command) => command.extensionId === WORKFLOWS_EXTENSION_ID,
          )
          const displayNames = workflowCommands.map((command) => command.displayName ?? "")
          expect(displayNames.toSorted((a, b) => a.localeCompare(b))).toEqual([
            "Audit",
            "Counsel",
            "Plan",
            "Research",
            "Review",
          ])
          expect(workflowCommands.find((command) => command.displayName === "Plan")).toMatchObject({
            category: "Workflow",
            keybind: "ctrl+shift+p",
          })

          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: WORKFLOWS_EXTENSION_ID,
            capabilityId: "plan-command",
            input: "implement caching",
          })

          // The recipe is a queued follow-up; it runs as the next turn.
          const queue = yield* client.queue.get({ sessionId, branchId })
          expect(queue.followUp).toHaveLength(1)
          const content = queue.followUp[0]?.content ?? ""
          expect(content).toContain("implement caching")
          expect(content).toContain("Promise.all")
          expect(content).toContain("artifact_save (sourceTool 'plan'")
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )
})
