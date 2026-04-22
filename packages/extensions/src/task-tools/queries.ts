/**
 * Task-tools queries — typed read-only Capabilities authored through the
 * `request({ intent: "read", ... })` factory (B11.5).
 *
 * The factory's `intent: "read"` overload constrains the handler's R
 * channel to `ReadOnlyTag`, so write-capable service Tags fail to
 * compile here. `TaskService` is a wide read+write Tag; we yield
 * `TaskStorageReadOnly` (the branded sub-Tag from B11.4) instead.
 *
 * `CapabilityRef`s keep the routing key and read/write fence together.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import {
  CapabilityError,
  type CapabilityRef,
  request,
  Task,
  TaskId,
} from "@gent/core/extensions/api"
import { TaskStorageReadOnly } from "../task-tools-storage.js"
import { TASK_TOOLS_EXTENSION_ID } from "./identity.js"

// ── GetTask ──

export const TaskGetInput = Schema.Struct({ taskId: TaskId })
export const TaskGetOutput = Schema.NullOr(Task)

export const TaskGetQuery = request({
  id: "task.get",
  intent: "read",
  input: TaskGetInput,
  output: TaskGetOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const storage = yield* TaskStorageReadOnly
      const task = yield* storage.getTask(input.taskId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.get",
              reason: `TaskStorage.getTask failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return task ?? null
    }),
})

export const TaskGetRef: CapabilityRef<typeof TaskGetInput.Type, typeof TaskGetOutput.Type> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.get",
  intent: "read",
  input: TaskGetInput,
  output: TaskGetOutput,
}

// ── ListTasks ──

export const TaskListInput = Schema.Struct({})
export const TaskListOutput = Schema.Array(Task)

export const TaskListQuery = request({
  id: "task.list",
  intent: "read",
  input: TaskListInput,
  output: TaskListOutput,
  // CapabilityCoreContext supplies sessionId + branchId; list scopes to
  // the active session, narrowing to the active branch.
  execute: (_input, ctx) =>
    Effect.gen(function* () {
      const storage = yield* TaskStorageReadOnly
      return yield* storage.listTasks(ctx.sessionId, ctx.branchId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.list",
              reason: `TaskStorage.listTasks failed: ${String(e)}`,
            }),
          ),
        ),
      )
    }),
})

export const TaskListRef: CapabilityRef<typeof TaskListInput.Type, typeof TaskListOutput.Type> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.list",
  intent: "read",
  input: TaskListInput,
  output: TaskListOutput,
}

// ── GetDependencies ──

export const TaskGetDepsInput = Schema.Struct({ taskId: TaskId })
export const TaskGetDepsOutput = Schema.Array(TaskId)

export const TaskGetDepsQuery = request({
  id: "task.getDeps",
  intent: "read",
  input: TaskGetDepsInput,
  output: TaskGetDepsOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const storage = yield* TaskStorageReadOnly
      return yield* storage.getTaskDeps(input.taskId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              capabilityId: "task.getDeps",
              reason: `TaskStorage.getTaskDeps failed: ${String(e)}`,
            }),
          ),
        ),
      )
    }),
})

export const TaskGetDepsRef: CapabilityRef<
  typeof TaskGetDepsInput.Type,
  typeof TaskGetDepsOutput.Type
> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.getDeps",
  intent: "read",
  input: TaskGetDepsInput,
  output: TaskGetDepsOutput,
}
