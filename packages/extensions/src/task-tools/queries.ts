/**
 * Task-tools queries — typed read-only Capabilities (C4.2 migration).
 *
 * Authored as `CapabilityContribution`s with `intent: "read"` and
 * `audiences: ["agent-protocol", "transport-public"]`. The legacy `compileQueries` dispatcher
 * lowers them into `QueryContribution`-shaped entries so existing callers
 * (`ctx.extension.query(ref, input)`) keep working unchanged.
 *
 * Refs (`TaskGetRef`, `TaskListRef`, `TaskGetDepsRef`) are still exported as
 * `QueryRef`-shaped values; their `queryId` matches the capability's `id`,
 * so routing through the bridge is identity-preserving. C4.5 swaps them to
 * `CapabilityRef` once the legacy types are deleted.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import {
  type CapabilityContribution,
  type CapabilityCoreContext,
  CapabilityError,
  type QueryRef,
  Task,
  TaskId,
} from "@gent/core/extensions/api"
import { TaskService } from "../task-tools-service.js"
import { TASK_TOOLS_EXTENSION_ID } from "./identity.js"

// ── GetTask ──

export const TaskGetInput = Schema.Struct({ taskId: TaskId })
export const TaskGetOutput = Schema.NullOr(Task)

export const TaskGetQuery: CapabilityContribution<
  typeof TaskGetInput.Type,
  typeof TaskGetOutput.Type,
  TaskService
> = {
  id: "task.get",
  audiences: ["agent-protocol", "transport-public"],
  intent: "read",
  input: TaskGetInput,
  output: TaskGetOutput,
  effect: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const task = yield* taskService.get(input.taskId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.get",
              reason: `TaskService.get failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return task ?? null
    }),
}

export const TaskGetRef: QueryRef<typeof TaskGetInput.Type, typeof TaskGetOutput.Type> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  queryId: "task.get",
  input: TaskGetInput,
  output: TaskGetOutput,
}

// ── ListTasks ──

export const TaskListInput = Schema.Struct({})
export const TaskListOutput = Schema.Array(Task)

export const TaskListQuery: CapabilityContribution<
  typeof TaskListInput.Type,
  typeof TaskListOutput.Type,
  TaskService
> = {
  id: "task.list",
  audiences: ["agent-protocol", "transport-public"],
  intent: "read",
  input: TaskListInput,
  output: TaskListOutput,
  effect: (_input, ctx: CapabilityCoreContext) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      // CapabilityCoreContext supplies sessionId + branchId; list scopes to
      // the active session, narrowing to the active branch.
      return yield* taskService.list(ctx.sessionId, ctx.branchId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.list",
              reason: `TaskService.list failed: ${String(e)}`,
            }),
          ),
        ),
      )
    }),
}

export const TaskListRef: QueryRef<typeof TaskListInput.Type, typeof TaskListOutput.Type> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  queryId: "task.list",
  input: TaskListInput,
  output: TaskListOutput,
}

// ── GetDependencies ──

export const TaskGetDepsInput = Schema.Struct({ taskId: TaskId })
export const TaskGetDepsOutput = Schema.Array(TaskId)

export const TaskGetDepsQuery: CapabilityContribution<
  typeof TaskGetDepsInput.Type,
  typeof TaskGetDepsOutput.Type,
  TaskService
> = {
  id: "task.getDeps",
  audiences: ["agent-protocol", "transport-public"],
  intent: "read",
  input: TaskGetDepsInput,
  output: TaskGetDepsOutput,
  effect: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      return yield* taskService.getDeps(input.taskId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.getDeps",
              reason: `TaskService.getDeps failed: ${String(e)}`,
            }),
          ),
        ),
      )
    }),
}

export const TaskGetDepsRef: QueryRef<typeof TaskGetDepsInput.Type, typeof TaskGetDepsOutput.Type> =
  {
    extensionId: TASK_TOOLS_EXTENSION_ID,
    queryId: "task.getDeps",
    input: TaskGetDepsInput,
    output: TaskGetDepsOutput,
  }
