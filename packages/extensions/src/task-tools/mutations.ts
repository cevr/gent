/**
 * Task-tools mutations — typed write Capabilities (C4.2 migration).
 *
 * Authored as `CapabilityContribution`s with `intent: "write"` and
 * `audiences: ["agent-protocol", "transport-public"]`. The legacy `compileMutations` dispatcher
 * lowers them into `MutationContribution`-shaped entries so existing callers
 * (`ctx.extension.mutate(ref, input)`) keep working unchanged.
 *
 * Refs (`TaskCreateRef`, …) remain `MutationRef`-shaped during the C4.2-4
 * migration; their `mutationId` matches the capability's `id`. C4.5 swaps
 * them to `CapabilityRef` once the legacy types are deleted.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import {
  AgentName,
  type CapabilityContribution,
  type CapabilityCoreContext,
  CapabilityError,
  EventPublisher,
  type MutationRef,
  Task,
  TaskId,
} from "@gent/core/extensions/api"
import { TaskService } from "../task-tools-service.js"
import { TASK_TOOLS_EXTENSION_ID } from "./identity.js"

// ── CreateTask ──

export const TaskCreateInput = Schema.Struct({
  subject: Schema.String,
  description: Schema.optional(Schema.String),
  agentType: Schema.optional(AgentName),
  prompt: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
})
export const TaskCreateOutput = Task

export const TaskCreateMutation: CapabilityContribution<
  typeof TaskCreateInput.Type,
  typeof TaskCreateOutput.Type,
  TaskService | EventPublisher
> = {
  id: "task.create",
  audiences: ["agent-protocol", "transport-public"],
  intent: "write",
  input: TaskCreateInput,
  output: TaskCreateOutput,
  effect: (input, ctx: CapabilityCoreContext) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const eventPublisher = yield* EventPublisher
      return yield* taskService
        .create({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          subject: input.subject,
          description: input.description,
          agentType: input.agentType,
          prompt: input.prompt,
          cwd: input.cwd,
          metadata: input.metadata,
        })
        .pipe(Effect.provideService(EventPublisher, eventPublisher))
    }),
}

export const TaskCreateRef: MutationRef<typeof TaskCreateInput.Type, typeof TaskCreateOutput.Type> =
  {
    extensionId: TASK_TOOLS_EXTENSION_ID,
    mutationId: "task.create",
    input: TaskCreateInput,
    output: TaskCreateOutput,
  }

// ── UpdateTask ──

export const TaskUpdateInput = Schema.Struct({
  taskId: TaskId,
  status: Schema.optional(
    Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]),
  ),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.Unknown)),
})
export const TaskUpdateOutput = Schema.NullOr(Task)

export const TaskUpdateMutation: CapabilityContribution<
  typeof TaskUpdateInput.Type,
  typeof TaskUpdateOutput.Type,
  TaskService | EventPublisher
> = {
  id: "task.update",
  audiences: ["agent-protocol", "transport-public"],
  intent: "write",
  input: TaskUpdateInput,
  output: TaskUpdateOutput,
  effect: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const eventPublisher = yield* EventPublisher
      const { taskId, ...fields } = input
      const result = yield* taskService
        .update(taskId, fields)
        .pipe(Effect.orDie, Effect.provideService(EventPublisher, eventPublisher))
      return result ?? null
    }),
}

export const TaskUpdateRef: MutationRef<typeof TaskUpdateInput.Type, typeof TaskUpdateOutput.Type> =
  {
    extensionId: TASK_TOOLS_EXTENSION_ID,
    mutationId: "task.update",
    input: TaskUpdateInput,
    output: TaskUpdateOutput,
  }

// ── DeleteTask ──

export const TaskDeleteInput = Schema.Struct({ taskId: TaskId })
export const TaskDeleteOutput = Schema.Null

export const TaskDeleteMutation: CapabilityContribution<
  typeof TaskDeleteInput.Type,
  typeof TaskDeleteOutput.Type,
  TaskService | EventPublisher
> = {
  id: "task.delete",
  audiences: ["agent-protocol", "transport-public"],
  intent: "write",
  input: TaskDeleteInput,
  output: TaskDeleteOutput,
  effect: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const eventPublisher = yield* EventPublisher
      yield* taskService
        .remove(input.taskId)
        .pipe(Effect.provideService(EventPublisher, eventPublisher))
      return null
    }),
}

export const TaskDeleteRef: MutationRef<typeof TaskDeleteInput.Type, typeof TaskDeleteOutput.Type> =
  {
    extensionId: TASK_TOOLS_EXTENSION_ID,
    mutationId: "task.delete",
    input: TaskDeleteInput,
    output: TaskDeleteOutput,
  }

// ── AddDependency ──

export const TaskAddDepInput = Schema.Struct({ taskId: TaskId, blockedById: TaskId })
export const TaskAddDepOutput = Schema.Null

export const TaskAddDepMutation: CapabilityContribution<
  typeof TaskAddDepInput.Type,
  typeof TaskAddDepOutput.Type,
  TaskService
> = {
  id: "task.addDep",
  audiences: ["agent-protocol", "transport-public"],
  intent: "write",
  input: TaskAddDepInput,
  output: TaskAddDepOutput,
  effect: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      yield* taskService.addDep(input.taskId, input.blockedById).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.addDep",
              reason: `TaskService.addDep failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return null
    }),
}

export const TaskAddDepRef: MutationRef<typeof TaskAddDepInput.Type, typeof TaskAddDepOutput.Type> =
  {
    extensionId: TASK_TOOLS_EXTENSION_ID,
    mutationId: "task.addDep",
    input: TaskAddDepInput,
    output: TaskAddDepOutput,
  }

// ── RemoveDependency ──

export const TaskRemoveDepInput = Schema.Struct({ taskId: TaskId, blockedById: TaskId })
export const TaskRemoveDepOutput = Schema.Null

export const TaskRemoveDepMutation: CapabilityContribution<
  typeof TaskRemoveDepInput.Type,
  typeof TaskRemoveDepOutput.Type,
  TaskService
> = {
  id: "task.removeDep",
  audiences: ["agent-protocol", "transport-public"],
  intent: "write",
  input: TaskRemoveDepInput,
  output: TaskRemoveDepOutput,
  effect: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      yield* taskService.removeDep(input.taskId, input.blockedById).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.removeDep",
              reason: `TaskService.removeDep failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return null
    }),
}

export const TaskRemoveDepRef: MutationRef<
  typeof TaskRemoveDepInput.Type,
  typeof TaskRemoveDepOutput.Type
> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  mutationId: "task.removeDep",
  input: TaskRemoveDepInput,
  output: TaskRemoveDepOutput,
}
