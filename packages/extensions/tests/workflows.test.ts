/**
 * Workflow commands RPC acceptance test. Each slash command queues a recipe
 * prompt that runs as a model turn through the per-request scope.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Order, Path, Schema, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  LanguageModelLayers,
  type SequenceStep,
  textStep,
  toolCallStep,
  createRpcHarness,
  waitFor,
} from "@gent/core/test-utils"
import {
  ORCHESTRATE_LIGHT_MACHINE,
  ORCHESTRATE_MACHINE,
  WorkflowsExtension,
} from "../src/workflows.js"
import { e2ePreset } from "./helpers/test-preset"
import { type BranchId, messagePartsText, type SessionId } from "@gent/core/protocol"

const WORKFLOWS_EXTENSION_ID = WorkflowsExtension.manifest.id
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

/** A scripted model that answers each of `turns` recipe turns with one line. */
const recipeModel = (turns: number) =>
  LanguageModelLayers.sequence(
    Array.from({ length: turns }, (_, index) => textStep(`recipe ${index + 1} done`)),
  )

/**
 * The recipes the branch received, in order: each command's request returns
 * once its recipe is queued (a request waits for a running turn to end), and
 * each recipe runs its own turn. Waits until `count` turns ran.
 */
const recipesOf = (
  client: Effect.Success<ReturnType<typeof createRpcHarness>>["client"],
  place: { readonly sessionId: SessionId; readonly branchId: BranchId },
  count: number,
) =>
  Effect.gen(function* () {
    const ran = yield* waitFor(
      client.session.getSnapshot(place),
      (current) =>
        current.runtime._tag === "Idle" &&
        current.messages.filter((message) => message.role === "user").length >= count &&
        current.messages.some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === `recipe ${count} done`,
          ),
        ),
      10_000,
      `${count} recipe turns`,
    )
    return ran.messages
      .filter((message) => message.role === "user")
      .map((message) => messagePartsText(message.parts))
  })

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
        steps[0] = toolCallStep("write", { path: planPath, content, atomic: true })
        steps[1] = toolCallStep("write", { path: exportPath, content, atomic: true })
        steps[3] = toolCallStep("read", { path: planPath })
        // The command is the new session's first message: its recipe starts the turn at once.
        const completion = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: WORKFLOWS_EXTENSION_ID,
          capabilityId: "plan-command",
          input: "prepare a plan and export it",
        })
        yield* Fiber.join(completion)
        const recipe = (yield* client.session.getSnapshot({ sessionId, branchId })).messages
          .map((message) => messagePartsText(message.parts))
          .find((text) => text.includes(planPath))
        expect(recipe).toContain("export a separate copy after the canonical save")
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
        yield* controls.waitForCall(4)
        yield* controls.assertDone
        expect(yield* fs.readFileString(planPath)).toBe(content)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "slash commands are listed and each /plan runs its own recipe",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* recipeModel(2)
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const commands = yield* client.extension.listSlashCommands({ sessionId })
          const workflowCommands = commands.filter(
            (command) => command.extensionId === WORKFLOWS_EXTENSION_ID,
          )
          const displayNames = workflowCommands.map((command) => command.displayName ?? "")
          expect(displayNames.toSorted(Order.String)).toEqual([
            "Audit",
            "Counsel",
            "Handoff",
            "Orchestrate",
            "Plan",
            "Research",
            "Review",
          ])
          expect(workflowCommands.find((command) => command.displayName === "Plan")).toMatchObject({
            category: "Workflow",
            keybind: "ctrl+shift+p",
          })

          // Each command is its own request: a repeat queues a second recipe.
          for (const input of ["implement caching", "then the second task"]) {
            yield* client.extension.request({
              sessionId,
              branchId,
              extensionId: WORKFLOWS_EXTENSION_ID,
              capabilityId: "plan-command",
              input,
            })
          }

          // Each recipe runs as its own turn, in order.
          const recipes = yield* recipesOf(client, { sessionId, branchId }, 2)
          expect(recipes).toHaveLength(2)
          expect(recipes[1]).toContain("then the second task")
          const content = recipes[0] ?? ""
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
        const { layer: providerLayer } = yield* recipeModel(6)
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        for (const capabilityId of [
          "review-command",
          "audit-command",
          "counsel-command",
          "research-command",
          "handoff-command",
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
        const recipes = yield* recipesOf(client, { sessionId, branchId }, 6)
        expect(recipes).toHaveLength(6)
        const [review, audit, counsel, research, handoff, savedPlan] = recipes
        expect(review).toContain("Review: inspect the fixture\n")
        expect(review).toContain("Do not edit source files")
        expect(audit).toContain("Audit: inspect the fixture\n")
        expect(audit).toContain("Do not edit source files")
        expect(counsel).toContain("second opinion on inspect the fixture:")
        expect(counsel).toContain("different model")
        expect(research).toContain("Research: inspect the fixture\n")
        expect(research).toContain("citations")
        expect(handoff).toContain("Use the handoff tool with the distilled context")
        expect(handoff).toContain("\nFocus: inspect the fixture")
        expect(savedPlan).toContain(`/.gent/results/${sessionId}/${branchId}/plan.md`)
        expect(savedPlan).toContain("Do not depend on kernel bindings")
        expect(savedPlan).not.toContain("atomic: true")
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )

  it.scopedLive(
    "/orchestrate writes the shipped machine, keeps a project's own, and runs its outcome prompt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-orchestrate-" })
        const { layer: providerLayer } = yield* recipeModel(3)
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd,
        })
        const orchestrate = (input: string) =>
          client.extension.request({
            sessionId,
            branchId,
            extensionId: WORKFLOWS_EXTENSION_ID,
            capabilityId: "orchestrate-command",
            input,
          })
        const machineFile = path.join(cwd, ".gent", "machines", "orchestrate.json")
        const lightFile = path.join(cwd, ".gent", "machines", "orchestrate-light.json")
        yield* orchestrate("  plans/next.md  ")
        // The file machine.start reads, as machine.define would write it.
        expect(decodeJson(yield* fs.readFileString(machineFile))).toEqual(ORCHESTRATE_MACHINE)
        // The verifier's clean checkout is a new worktree too.
        expect(ORCHESTRATE_MACHINE.threads?.["verifier"]?.instructions).toContain(
          "with the project's packages installed there first",
        )
        expect(decodeJson(yield* fs.readFileString(lightFile))).toEqual(ORCHESTRATE_LIGHT_MACHINE)
        // Every round of both machines stops on size at two handoffs and goes to decide.
        for (const machine of [ORCHESTRATE_MACHINE, ORCHESTRATE_LIGHT_MACHINE]) {
          const sizes = Object.values(machine.states).flatMap((state) => {
            if (state.kind !== "thread") return []
            return [state.oversize]
          })
          expect(sizes.length).toBeGreaterThan(3)
          for (const size of sizes) expect(size).toEqual({ handoffs: 2, to: "decide" })
        }
        expect(ORCHESTRATE_MACHINE.threads?.["planner"]?.instructions).toContain(
          "A bulk mechanical unit (the same edit across many files) starts with a codemod",
        )
        const own = '{ "name": "orchestrate", "mine": true }\n'
        yield* fs.writeFileString(machineFile, own)
        yield* orchestrate("plans/next.md")
        expect(yield* fs.readFileString(machineFile)).toBe(own)
        // A project file the command cannot read is not absent: the command fails and never replaces it.
        yield* fs.chmod(machineFile, 0o000)
        const unreadable = yield* Effect.exit(orchestrate("plans/next.md"))
        yield* fs.chmod(machineFile, 0o644)
        expect(unreadable._tag).toBe("Failure")
        expect(yield* fs.readFileString(machineFile)).toBe(own)
        yield* orchestrate("")
        const [shipped, kept, empty] = yield* recipesOf(client, { sessionId, branchId }, 3)
        expect(shipped).toContain("Orchestrate: plans/next.md\n")
        expect(shipped).toContain(`/.gent/results/${sessionId}/${branchId}/orchestrate/plan.md`)
        expect(shipped).toContain("write no product code")
        expect(shipped).toContain("machine.start the orchestrate machine")
        // A worktree has no node_modules: a merge gate that needs them failed live without this.
        expect(shipped).toContain(
          "a new worktree has no installed packages, so install them there before the first gate",
        )
        // A size stop is a replan, and a bulk mechanical unit starts with a codemod.
        expect(shipped).toContain("after a size stop")
        expect(shipped).toContain("replan it smaller")
        expect(shipped).toContain("starts with a codemod")
        expect(shipped).toContain(`The orchestrate machine is ${machineFile}.`)
        expect(shipped).toContain(`The orchestrate-light machine is ${lightFile}.`)
        expect(kept).toContain(
          `${machineFile} differs from the shipped orchestrate machine and was kept`,
        )
        expect(empty).toBe("Ask which plan or goal to orchestrate.")
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
    10_000,
  )

  it.live(
    "a slash command typed in a spawned child runs as its user: /handoff and /plan keep their interactive tools",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("child warmed"),
            toolCallStep("handoff", { context: "carry on from the child" }),
            textStep("handed off"),
            toolCallStep("prompt", { mode: "confirm", content: "approve the plan?" }),
            textStep("plan confirmed"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const child = yield* client.session.create({
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          const toolResult = (toolName: string, reply: string) =>
            Effect.gen(function* () {
              const snapshot = yield* waitFor(
                client.session.getSnapshot(child),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  current.messages.some((message) =>
                    message.parts.some((part) => part.type === "text" && part.text === reply),
                  ),
                5_000,
                `reply ${reply}`,
              )
              return snapshot.messages.flatMap((message) =>
                message.parts.flatMap((part) => {
                  if (part.type === "tool-result" && part.name === toolName)
                    return [encodeJson(part.result)]
                  return []
                }),
              )
            })
          // A child the user opens has run before: its loop is warm.
          yield* client.message.send({ ...child, content: "warm the child" })
          yield* toolResult("none", "child warmed")
          const commands: ReadonlyArray<{
            readonly capabilityId: string
            readonly toolName: string
            readonly reply: string
            readonly expected: string
          }> = [
            {
              capabilityId: "handoff-command",
              toolName: "handoff",
              reply: "handed off",
              expected: '"handoff":true',
            },
            {
              capabilityId: "plan-command",
              toolName: "prompt",
              reply: "plan confirmed",
              expected: '"decision":"yes"',
            },
          ]
          for (const { capabilityId, toolName, reply, expected } of commands) {
            yield* client.extension.request({
              ...child,
              extensionId: WORKFLOWS_EXTENSION_ID,
              capabilityId,
              input: "",
            })
            const [result] = yield* toolResult(toolName, reply)
            expect(result).toContain(expected)
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
