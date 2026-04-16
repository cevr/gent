/**
 * Task-tools queries — typed read-only RPC handlers.
 *
 * Replaces the actor's `GetTask`/`ListTasks`/`GetDependencies` request paths
 * with `QueryContribution`s. Each handler reads from `TaskService` (which
 * delegates to `TaskStorage`) and returns typed output via Schema.
 *
 * The handlers are read-only by design — `gent/no-projection-writes` lint
 * applies (TaskService.get/list/getDeps are read methods).
 *
 * @module
 */
import { Effect, Schema } from "effect"
import {
  type QueryContribution,
  type QueryRef,
  QueryError,
  Task,
  TaskId,
} from "@gent/core/extensions/api"
import { TaskService } from "../task-tools-service.js"
import { TASK_TOOLS_EXTENSION_ID } from "./identity.js"

// ── GetTask ──

export const TaskGetInput = Schema.Struct({ taskId: TaskId })
export const TaskGetOutput = Schema.NullOr(Task)

export const TaskGetQuery: QueryContribution<
  typeof TaskGetInput.Type,
  typeof TaskGetOutput.Type,
  TaskService
> = {
  id: "task.get",
  input: TaskGetInput,
  output: TaskGetOutput,
  handler: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const task = yield* taskService.get(input.taskId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new QueryError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              queryId: "task.get",
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

export const TaskListQuery: QueryContribution<
  typeof TaskListInput.Type,
  typeof TaskListOutput.Type,
  TaskService
> = {
  id: "task.list",
  input: TaskListInput,
  output: TaskListOutput,
  handler: (_input, ctx) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      // QueryContext supplies sessionId + (optional) branchId; list scopes to
      // the active session, optionally narrowing to a branch.
      return yield* taskService.list(ctx.sessionId, ctx.branchId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new QueryError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              queryId: "task.list",
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

export const TaskGetDepsQuery: QueryContribution<
  typeof TaskGetDepsInput.Type,
  typeof TaskGetDepsOutput.Type,
  TaskService
> = {
  id: "task.getDeps",
  input: TaskGetDepsInput,
  output: TaskGetDepsOutput,
  handler: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      return yield* taskService.getDeps(input.taskId).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new QueryError({
              extensionId: TASK_TOOLS_EXTENSION_ID,
              queryId: "task.getDeps",
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
