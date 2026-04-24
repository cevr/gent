/**
 * Task-tools requests — typed request Capabilities authored through the
 * unified `request({ intent, ... })` factory.
 *
 * Read-intent requests yield `TaskStorageReadOnly`; write-intent requests
 * yield `TaskService` and publish task lifecycle events as needed.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import {
  AgentName,
  type CapabilityRef,
  CapabilityError,
  request,
  Task,
  TaskId,
} from "@gent/core/extensions/api"
import { EventPublisher } from "../builtin-internal.js"
import { TaskService } from "../task-tools-service.js"
import { TaskStorageReadOnly } from "../task-tools-storage.js"
import { TASK_TOOLS_EXTENSION_ID } from "./identity.js"

// ── Read Requests ──

export const TaskGetInput = Schema.Struct({ taskId: TaskId })
export const TaskGetOutput = Schema.NullOr(Task)

export const TaskGetRequest = request({
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

export const TaskListInput = Schema.Struct({})
export const TaskListOutput = Schema.Array(Task)

export const TaskListRequest = request({
  id: "task.list",
  intent: "read",
  input: TaskListInput,
  output: TaskListOutput,
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

export const TaskGetDepsInput = Schema.Struct({ taskId: TaskId })
export const TaskGetDepsOutput = Schema.Array(TaskId)

export const TaskGetDepsRequest = request({
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

// ── Write Requests ──

export const TaskCreateInput = Schema.Struct({
  subject: Schema.String,
  description: Schema.optional(Schema.String),
  agentType: Schema.optional(AgentName),
  prompt: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
})
export const TaskCreateOutput = Task

export const TaskCreateRequest = request({
  id: "task.create",
  intent: "write",
  input: TaskCreateInput,
  output: TaskCreateOutput,
  execute: (input, ctx) =>
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
        .pipe(
          Effect.provideService(EventPublisher, eventPublisher),
          Effect.catchEager((e) =>
            Effect.fail(
              new CapabilityError({
                extensionId: TASK_TOOLS_EXTENSION_ID,
                capabilityId: "task.create",
                reason: `TaskService.create failed: ${String(e)}`,
              }),
            ),
          ),
        )
    }),
})

export const TaskCreateRef: CapabilityRef<
  typeof TaskCreateInput.Type,
  typeof TaskCreateOutput.Type
> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.create",
  intent: "write",
  input: TaskCreateInput,
  output: TaskCreateOutput,
}

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

export const TaskUpdateRequest = request({
  id: "task.update",
  intent: "write",
  input: TaskUpdateInput,
  output: TaskUpdateOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const eventPublisher = yield* EventPublisher
      const { taskId, ...fields } = input
      const result = yield* taskService
        .update(taskId, fields)
        .pipe(Effect.orDie, Effect.provideService(EventPublisher, eventPublisher))
      return result ?? null
    }),
})

export const TaskUpdateRef: CapabilityRef<
  typeof TaskUpdateInput.Type,
  typeof TaskUpdateOutput.Type
> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.update",
  intent: "write",
  input: TaskUpdateInput,
  output: TaskUpdateOutput,
}

export const TaskDeleteInput = Schema.Struct({ taskId: TaskId })
export const TaskDeleteOutput = Schema.Null

export const TaskDeleteRequest = request({
  id: "task.delete",
  intent: "write",
  input: TaskDeleteInput,
  output: TaskDeleteOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const eventPublisher = yield* EventPublisher
      yield* taskService
        .remove(input.taskId)
        .pipe(Effect.provideService(EventPublisher, eventPublisher))
      return null
    }),
})

export const TaskDeleteRef: CapabilityRef<
  typeof TaskDeleteInput.Type,
  typeof TaskDeleteOutput.Type
> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.delete",
  intent: "write",
  input: TaskDeleteInput,
  output: TaskDeleteOutput,
}

export const TaskAddDepInput = Schema.Struct({ taskId: TaskId, blockedById: TaskId })
export const TaskAddDepOutput = Schema.Null

export const TaskAddDepRequest = request({
  id: "task.addDep",
  intent: "write",
  input: TaskAddDepInput,
  output: TaskAddDepOutput,
  execute: (input) =>
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
})

export const TaskAddDepRef: CapabilityRef<
  typeof TaskAddDepInput.Type,
  typeof TaskAddDepOutput.Type
> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.addDep",
  intent: "write",
  input: TaskAddDepInput,
  output: TaskAddDepOutput,
}

export const TaskRemoveDepInput = Schema.Struct({ taskId: TaskId, blockedById: TaskId })
export const TaskRemoveDepOutput = Schema.Null

export const TaskRemoveDepRequest = request({
  id: "task.removeDep",
  intent: "write",
  input: TaskRemoveDepInput,
  output: TaskRemoveDepOutput,
  execute: (input) =>
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
})

export const TaskRemoveDepRef: CapabilityRef<
  typeof TaskRemoveDepInput.Type,
  typeof TaskRemoveDepOutput.Type
> = {
  extensionId: TASK_TOOLS_EXTENSION_ID,
  capabilityId: "task.removeDep",
  intent: "write",
  input: TaskRemoveDepInput,
  output: TaskRemoveDepOutput,
}
