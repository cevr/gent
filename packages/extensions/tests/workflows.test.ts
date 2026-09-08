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
  it.scopedLive("keeps repeated commands as distinct requests", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
      })
      for (const input of ["first task", "second task"]) {
        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: WORKFLOWS_EXTENSION_ID,
          capabilityId: "plan-command",
          input,
        })
      }
      const { followUp } = yield* client.queue.get({ sessionId, branchId })
      expect(followUp).toHaveLength(2)
      expect(followUp[0]?.content).toContain("first task")
      expect(followUp[1]?.content).toContain("second task")
    }).pipe(Effect.timeout("4 seconds")),
  )

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
          expect(content).toContain("artifact_save (sourceTool 'plan'")
          expect(content).toContain("Obtain approval before code changes")
          expect(content).toContain("separate cell")
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )

  it.scopedLive(
    "routes each workflow and keeps saved-plan lookup separate from planning",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        for (const capabilityId of [
          "review-command",
          "audit-command",
          "counsel-command",
          "research-command",
          "plan-command",
        ]) {
          let input = "  inspect the fixture  "
          if (capabilityId === "plan-command") input = "   "
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: WORKFLOWS_EXTENSION_ID,
            capabilityId,
            input,
          })
        }
        const { followUp } = yield* client.queue.get({ sessionId, branchId })
        expect(followUp).toHaveLength(5)
        const [review, audit, counsel, research, savedPlan] = followUp.map((item) => item.content)
        expect(review).toContain("Review: inspect the fixture\n")
        expect(review).toContain("Do not edit files")
        expect(audit).toContain("Audit: inspect the fixture\n")
        expect(audit).toContain("Do not edit files")
        expect(counsel).toContain("second opinion on inspect the fixture:")
        expect(counsel).toContain("different model")
        expect(research).toContain("Research: inspect the fixture\n")
        expect(research).toContain("citations")
        expect(savedPlan).toContain("artifact_read")
        expect(savedPlan).not.toContain("artifact_save")
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )
})
