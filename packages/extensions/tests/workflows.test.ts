/**
 * Workflow commands RPC acceptance test. Each slash command queues a recipe
 * prompt that runs as a model turn through the per-request scope.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Path, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import type { SequenceStep } from "@gent/core-internal/test-utils/language-model"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { WORKFLOWS_EXTENSION_ID } from "../src/workflows.js"
import { e2ePreset } from "./helpers/test-preset"

describe("WorkflowsExtension via RPC", () => {
  it.scopedLive(
    "saved plans and exports remain readable through a later empty plan request",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-saved-plan-" })
        const content = "Saved plan survives later requests.\n".repeat(100)
        const steps: SequenceStep[] = [
          textStep("READY"),
          textStep("save"),
          textStep("export"),
          textStep("Saved"),
          textStep("read"),
          textStep("Shown"),
        ]
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(steps)
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd,
        })
        const planPath = path.join(cwd, ".gent", "results", sessionId, branchId, "plan.md")
        const exportPath = path.join(cwd, "export.md")
        // Set the external model's scripted replies before its first request.
        steps[1] = toolCallStep("write", { path: planPath, content, atomic: true })
        steps[2] = toolCallStep("write", { path: exportPath, content, atomic: true })
        steps[4] = toolCallStep("read", { path: planPath })
        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: WORKFLOWS_EXTENSION_ID,
          capabilityId: "plan-command",
          input: "prepare a plan and export it",
        })
        const queue = yield* client.queue.get({ sessionId, branchId })
        expect(queue.followUp[0]?.content).toContain(planPath)
        expect(queue.followUp[0]?.content).toContain(
          "export a separate copy after the canonical save",
        )
        const completion = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "READY" })
        yield* Fiber.join(completion)
        expect(yield* fs.readFileString(planPath)).toBe(content)
        expect(yield* fs.readFileString(exportPath)).toBe(content)
        const readResult = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(
            (envelope) =>
              envelope.event._tag === "ToolCallSucceeded" && envelope.event.toolName === "read",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: WORKFLOWS_EXTENSION_ID,
          capabilityId: "plan-command",
          input: "   ",
        })
        const [readEvent] = yield* Fiber.join(readResult)
        expect(readEvent?.event._tag).toBe("ToolCallSucceeded")
        if (readEvent?.event._tag === "ToolCallSucceeded") {
          expect(readEvent.event.output).toContain("Saved plan survives later requests.")
        }
        yield* controls.waitForCall(5)
        yield* controls.assertDone
        expect(yield* fs.readFileString(planPath)).toBe(content)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
    15_000,
  )

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
          expect(content).toContain(`/.gent/results/${sessionId}/${branchId}/plan.md`)
          expect(content).toContain("atomic: true")
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
        expect(review).toContain("Do not edit source files")
        expect(audit).toContain("Audit: inspect the fixture\n")
        expect(audit).toContain("Do not edit source files")
        expect(counsel).toContain("second opinion on inspect the fixture:")
        expect(counsel).toContain("different model")
        expect(research).toContain("Research: inspect the fixture\n")
        expect(research).toContain("citations")
        expect(savedPlan).toContain(`/.gent/results/${sessionId}/${branchId}/plan.md`)
        expect(savedPlan).toContain("Do not depend on kernel bindings")
        expect(savedPlan).not.toContain("atomic: true")
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )
})
