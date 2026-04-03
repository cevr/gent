import { Effect, Schema } from "effect"
import { extension, fromReducer } from "./api.js"
import { TaskCreateTool } from "../tools/task-create.js"
import { TaskListTool } from "../tools/task-list.js"
import { TaskGetTool } from "../tools/task-get.js"
import { TaskUpdateTool } from "../tools/task-update.js"
import { TaskStopTool } from "../tools/task-stop.js"
import { TaskOutputTool } from "../tools/task-output.js"
import { TaskStorage } from "./task-tools-storage.js"
import { TaskService, type TaskRuntimeDeps } from "./task-tools-service.js"
import type { AgentEvent } from "../domain/event.js"
import type { TaskStatus } from "../domain/task.js"
import type { TaskId } from "../domain/ids.js"
import type { ExtensionReduceContext, ReduceResult } from "../domain/extension.js"
import { TASK_TOOLS_EXTENSION_ID, TaskProtocol } from "./task-tools-protocol.js"

// ── Task list actor — projects task state as extension UI snapshot ──

export interface TaskEntry {
  id: TaskId
  subject: string
  status: TaskStatus
}

export interface TaskListState {
  tasks: TaskEntry[]
}

const TaskListUiModel = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      subject: Schema.String,
      status: Schema.String,
    }),
  ),
})

const reduce = (
  state: TaskListState,
  event: AgentEvent,
  _ctx: ExtensionReduceContext,
): ReduceResult<TaskListState> => {
  switch (event._tag) {
    case "TaskCreated":
      return {
        state: {
          tasks: [
            ...state.tasks,
            { id: event.taskId, subject: event.subject, status: "pending" as const },
          ],
        },
      }
    case "TaskUpdated":
      return {
        state: {
          tasks: state.tasks.map((t) =>
            t.id === event.taskId ? { ...t, status: event.status as TaskStatus } : t,
          ),
        },
      }
    case "TaskCompleted":
      return {
        state: {
          tasks: state.tasks.map((t) =>
            t.id === event.taskId ? { ...t, status: "completed" as const } : t,
          ),
        },
      }
    case "TaskFailed":
      return {
        state: {
          tasks: state.tasks.map((t) =>
            t.id === event.taskId ? { ...t, status: "failed" as const } : t,
          ),
        },
      }
    case "TaskStopped":
      return {
        state: {
          tasks: state.tasks.map((t) =>
            t.id === event.taskId ? { ...t, status: "stopped" as const } : t,
          ),
        },
      }
    case "TaskDeleted":
      return {
        state: { tasks: state.tasks.filter((t) => t.id !== event.taskId) },
      }
    default:
      return { state }
  }
}

const derive = (state: TaskListState) => ({
  uiModel: { tasks: state.tasks },
})

/** Exported for pure test harness access */
export const TaskListActorConfig = {
  id: TASK_TOOLS_EXTENSION_ID,
  initial: { tasks: [] } satisfies TaskListState,
  reduce,
  derive,
}

type TaskRequest =
  | ReturnType<typeof TaskProtocol.CreateTask>
  | ReturnType<typeof TaskProtocol.GetTask>
  | ReturnType<typeof TaskProtocol.ListTasks>
  | ReturnType<typeof TaskProtocol.UpdateTask>
  | ReturnType<typeof TaskProtocol.RunTask>
  | ReturnType<typeof TaskProtocol.StopTask>
  | ReturnType<typeof TaskProtocol.DeleteTask>
  | ReturnType<typeof TaskProtocol.GetTaskOutput>
  | ReturnType<typeof TaskProtocol.AddDependency>
  | ReturnType<typeof TaskProtocol.RemoveDependency>
  | ReturnType<typeof TaskProtocol.GetDependencies>

const taskListActor = fromReducer<
  TaskListState,
  never,
  TaskRequest,
  TaskStorage,
  TaskService | TaskRuntimeDeps
>({
  ...TaskListActorConfig,
  uiModelSchema: TaskListUiModel,
  request: (_state, message) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      switch (message._tag) {
        case "CreateTask":
          return { state: _state, reply: yield* taskService.create(message) }
        case "GetTask":
          return { state: _state, reply: (yield* taskService.get(message.taskId)) ?? null }
        case "ListTasks":
          return {
            state: _state,
            reply: yield* taskService.list(message.sessionId, message.branchId),
          }
        case "UpdateTask": {
          const { taskId, ...fields } = message
          return {
            state: _state,
            reply: (yield* taskService.update(taskId, fields).pipe(Effect.orDie)) ?? null,
          }
        }
        case "RunTask":
          return { state: _state, reply: yield* taskService.run(message.taskId) }
        case "StopTask":
          return { state: _state, reply: (yield* taskService.stop(message.taskId)) ?? null }
        case "DeleteTask":
          yield* taskService.remove(message.taskId)
          return { state: _state, reply: null }
        case "GetTaskOutput": {
          const output = yield* taskService.getOutput(message.taskId)
          const reply =
            output === undefined
              ? null
              : {
                  status: output.status,
                  messageCount: output.messages.length,
                  messages: output.messages.map((m) => {
                    const excerpt = m.parts
                      .filter(
                        (part): part is { type: "text"; text: string } => part.type === "text",
                      )
                      .map((part) => part.text)
                      .join("\n")
                      .slice(0, 200)
                    return { role: m.role, excerpt }
                  }),
                }
          return { state: _state, reply }
        }
        case "AddDependency":
          yield* taskService.addDep(message.taskId, message.blockedById)
          return { state: _state, reply: null }
        case "RemoveDependency":
          yield* taskService.removeDep(message.taskId, message.blockedById)
          return { state: _state, reply: null }
        case "GetDependencies":
          return { state: _state, reply: yield* taskService.getDeps(message.taskId) }
      }
    }),
  onInit: ({ sessionId, replaceState }) =>
    Effect.gen(function* () {
      const storageOpt = yield* Effect.serviceOption(TaskStorage)
      if (storageOpt._tag === "None") return
      const tasks = yield* storageOpt.value.listTasks(sessionId).pipe(Effect.orDie)
      if (tasks.length === 0) return
      yield* replaceState({
        tasks: tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
        })),
      } satisfies TaskListState)
    }),
})

// ── Extension ──

export const TaskExtension = extension("@gent/task-tools", (ext) => {
  ext.protocol(TaskProtocol)
  ext.tool(TaskCreateTool)
  ext.tool(TaskListTool)
  ext.tool(TaskGetTool)
  ext.tool(TaskUpdateTool)
  ext.tool(TaskStopTool)
  ext.tool(TaskOutputTool)
  ext.layer(TaskStorage.Live)
  ext.layer(TaskService.Live)
  ext.actor(taskListActor)
})

/** @deprecated Use TaskExtension. */
export const TaskToolsExtension = TaskExtension
