import { Context, Effect, Layer, Schema } from "effect"
import { defineTool, AgentMode, isToolAllowedInPlanMode } from "@gent/core"

// Plan Mode Handler Service

export interface PlanModeHandlerService {
  readonly getMode: () => Effect.Effect<AgentMode>
  readonly setMode: (mode: AgentMode) => Effect.Effect<void>
  readonly askUserForConfirmation: (question: string) => Effect.Effect<boolean>
}

export class PlanModeHandler extends Context.Tag("PlanModeHandler")<
  PlanModeHandler,
  PlanModeHandlerService
>() {
  static Test = (
    initialMode: AgentMode = "build",
    confirmations: ReadonlyArray<boolean> = [true],
  ): Layer.Layer<PlanModeHandler> => {
    let mode = initialMode
    let confirmIndex = 0
    return Layer.succeed(PlanModeHandler, {
      getMode: () => Effect.succeed(mode),
      setMode: (newMode) =>
        Effect.sync(() => {
          mode = newMode
        }),
      askUserForConfirmation: () => Effect.succeed(confirmations[confirmIndex++] ?? true),
    })
  }
}

// PlanEnter Params & Result
// Note: needs at least one property for Bedrock JSON schema compatibility

export const PlanEnterParams = Schema.Struct({
  _dummy: Schema.optional(Schema.Undefined),
})

export const PlanEnterResult = Schema.Struct({
  mode: AgentMode,
  message: Schema.String,
})

// PlanEnter Tool

export const PlanEnterTool = defineTool({
  name: "plan_enter",
  description:
    "Switch to plan mode for research and planning. In plan mode, only read-only tools are available (Read, Grep, Glob, WebFetch, Question). Use before making significant changes.",
  params: PlanEnterParams,
  execute: Effect.fn("PlanEnterTool.execute")(function* () {
    const handler = yield* PlanModeHandler
    const currentMode = yield* handler.getMode()

    if (currentMode === "plan") {
      return { mode: "plan" as const, message: "Already in plan mode" }
    }

    const confirmed = yield* handler.askUserForConfirmation(
      "Switch to plan mode? (Read-only tools only)",
    )

    if (!confirmed) {
      return { mode: "build" as const, message: "User declined plan mode" }
    }

    yield* handler.setMode("plan")
    return {
      mode: "plan" as const,
      message:
        "Switched to plan mode. Only read-only tools available: Read, Grep, Glob, WebFetch, Question, TodoRead.",
    }
  }),
})

// PlanExit Params & Result
// Note: needs at least one property for Bedrock JSON schema compatibility

export const PlanExitParams = Schema.Struct({
  _dummy: Schema.optional(Schema.Undefined),
})

export const PlanExitResult = Schema.Struct({
  mode: AgentMode,
  message: Schema.String,
})

// PlanExit Tool

export const PlanExitTool = defineTool({
  name: "plan_exit",
  description:
    "Exit plan mode and resume build mode with full tool access. Use after completing research/planning.",
  params: PlanExitParams,
  execute: Effect.fn("PlanExitTool.execute")(function* () {
    const handler = yield* PlanModeHandler
    const currentMode = yield* handler.getMode()

    if (currentMode === "build") {
      return { mode: "build" as const, message: "Already in build mode" }
    }

    const confirmed = yield* handler.askUserForConfirmation("Exit plan mode and resume building?")

    if (!confirmed) {
      return { mode: "plan" as const, message: "User chose to stay in plan mode" }
    }

    yield* handler.setMode("build")
    return {
      mode: "build" as const,
      message: "Resumed build mode. All tools available.",
    }
  }),
})

// Check if tool is allowed in current mode
// Uses PLAN_MODE_TOOLS from @gent/core as single source of truth

export const isToolAllowedInMode = (toolName: string, mode: AgentMode): boolean => {
  if (mode === "build") return true
  return isToolAllowedInPlanMode(toolName)
}
