import { Effect, Ref, Schema } from "effect"
import { extension, fromReducer } from "./api.js"
import { TaskCreateTool } from "../tools/task-create.js"
import { TaskListTool } from "../tools/task-list.js"
import { TaskGetTool } from "../tools/task-get.js"
import { TaskUpdateTool } from "../tools/task-update.js"
import { TaskStopTool } from "../tools/task-stop.js"
import { TaskOutputTool } from "../tools/task-output.js"
import { TaskStorage } from "../storage/task-storage.js"
import { TaskService } from "../runtime/task-service.js"
import type { AgentEvent } from "../domain/event.js"
import type { TaskStatus } from "../domain/task.js"
import type { TaskId } from "../domain/ids.js"
import type { ExtensionReduceContext, ReduceResult } from "../domain/extension.js"

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
  id: "@gent/task-tools" as const,
  initial: { tasks: [] } satisfies TaskListState,
  reduce,
  derive,
}

const taskListActor = fromReducer<TaskListState, never, TaskStorage>({
  ...TaskListActorConfig,
  uiModelSchema: TaskListUiModel,
  onInit: ({ sessionId, stateRef }) =>
    Effect.gen(function* () {
      const storageOpt = yield* Effect.serviceOption(TaskStorage)
      if (storageOpt._tag === "None") return
      const tasks = yield* storageOpt.value.listTasks(sessionId).pipe(Effect.orDie)
      if (tasks.length === 0) return
      yield* Ref.set(stateRef, {
        tasks: tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
        })),
      } satisfies TaskListState)
    }),
})

// ── Extension ──

export const TaskToolsExtension = extension("@gent/task-tools", (ext) => {
  ext.tool(TaskCreateTool)
  ext.tool(TaskListTool)
  ext.tool(TaskGetTool)
  ext.tool(TaskUpdateTool)
  ext.tool(TaskStopTool)
  ext.tool(TaskOutputTool)
  ext.layer(TaskStorage.Live)
  ext.layer(TaskService.Live, { phase: "runtime" })
  ext.actor(taskListActor)

  // Handle StopTask via bus — full service access for calling TaskService.stop()
  ext.bus.on("@gent/task-tools:StopTask", (envelope) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService
      const { taskId } = envelope.payload as { taskId: string }
      yield* taskService.stop(taskId as TaskId)
    }).pipe(Effect.catchEager(() => Effect.void)),
  )
})
