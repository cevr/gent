import { Effect, Schema } from "effect"
import { Event as MEvent, Machine, Slot, State as MState, type ProvideSlots } from "effect-machine"
import { extension } from "./api.js"
import { TaskCreateTool } from "../tools/task-create.js"
import { TaskListTool } from "../tools/task-list.js"
import { TaskGetTool } from "../tools/task-get.js"
import { TaskUpdateTool } from "../tools/task-update.js"
import { TaskStopTool } from "../tools/task-stop.js"
import { TaskOutputTool } from "../tools/task-output.js"
import { TaskStorage } from "./task-tools-storage.js"
import { TaskService, type TaskRuntimeDeps } from "./task-tools-service.js"
import { AgentEvent } from "../domain/event.js"
import { Task, TaskStatus } from "../domain/task.js"
import { BranchId, SessionId, TaskId } from "../domain/ids.js"
import type {
  ExtensionActorDefinition,
  ExtensionReduceContext,
  ReduceResult,
} from "../domain/extension.js"
import { TASK_TOOLS_EXTENSION_ID, TaskOutputSummary, TaskProtocol } from "./task-tools-protocol.js"

// ── Task list actor — projects task state as extension UI snapshot ──

export interface TaskEntry {
  readonly id: TaskId
  readonly subject: string
  readonly status: typeof TaskStatus.Type
}

export interface TaskListState {
  readonly tasks: ReadonlyArray<TaskEntry>
}

const TaskEntrySchema = Schema.Struct({
  id: TaskId,
  subject: Schema.String,
  status: TaskStatus,
})

const TaskListStateSchema = Schema.Struct({
  tasks: Schema.Array(TaskEntrySchema),
})

const taskEntry = (id: TaskId, subject: string, status: TaskEntry["status"]): TaskEntry => ({
  id,
  subject,
  status,
})

const isTaskEntryStatus = (status: string): status is TaskEntry["status"] =>
  Schema.is(TaskStatus)(status)

const reduce = (
  state: TaskListState,
  event: AgentEvent,
  _ctx: ExtensionReduceContext,
): ReduceResult<TaskListState> => {
  switch (event._tag) {
    case "TaskCreated":
      return {
        state: {
          tasks: [...state.tasks, taskEntry(event.taskId, event.subject, "pending")],
        },
      }
    case "TaskUpdated":
      if (!isTaskEntryStatus(event.status)) return { state }
      const updatedStatus = event.status
      return {
        state: {
          tasks: state.tasks.map((t) =>
            t.id === event.taskId ? taskEntry(t.id, t.subject, updatedStatus) : t,
          ),
        },
      }
    case "TaskCompleted":
      return {
        state: {
          tasks: state.tasks.map((t) =>
            t.id === event.taskId ? { ...t, status: "completed" } : t,
          ),
        },
      }
    case "TaskFailed":
      return {
        state: {
          tasks: state.tasks.map((t) => (t.id === event.taskId ? { ...t, status: "failed" } : t)),
        },
      }
    case "TaskStopped":
      return {
        state: {
          tasks: state.tasks.map((t) => (t.id === event.taskId ? { ...t, status: "stopped" } : t)),
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

const TaskMachineState = MState({
  Active: {
    tasks: TaskListStateSchema.fields.tasks,
  },
})

const TaskInstance = Schema.instanceOf(Task)
const NullableTaskInstance = Schema.NullOr(TaskInstance)
const TaskInstanceArray = Schema.Array(TaskInstance)

const TaskRunResult = Schema.Struct({
  taskId: TaskId,
  status: Schema.String,
  sessionId: Schema.optional(SessionId),
  branchId: Schema.optional(BranchId),
})

const TaskMachineSlots = Slot.define({
  hydrateTasks: Slot.fn({ sessionId: SessionId }, Schema.Array(Task)),
  createTask: Slot.fn(
    {
      sessionId: SessionId,
      branchId: BranchId,
      subject: Schema.String,
      description: Schema.optional(Schema.String),
      agentType: Schema.optional(Schema.String),
      prompt: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Unknown),
    },
    TaskInstance,
  ),
  getTask: Slot.fn({ taskId: TaskId }, NullableTaskInstance),
  listTasks: Slot.fn(
    {
      sessionId: SessionId,
      branchId: Schema.optional(BranchId),
    },
    TaskInstanceArray,
  ),
  updateTask: Slot.fn(
    {
      taskId: TaskId,
      status: Schema.optional(TaskStatus),
      description: Schema.optional(Schema.NullOr(Schema.String)),
      owner: Schema.optional(Schema.NullOr(SessionId)),
      metadata: Schema.optional(Schema.NullOr(Schema.Unknown)),
    },
    NullableTaskInstance,
  ),
  runTask: Slot.fn({ taskId: TaskId }, TaskRunResult),
  stopTask: Slot.fn({ taskId: TaskId }, NullableTaskInstance),
  deleteTask: Slot.fn({ taskId: TaskId }),
  getTaskOutput: Slot.fn({ taskId: TaskId }, Schema.NullOr(TaskOutputSummary)),
  addDependency: Slot.fn({ taskId: TaskId, blockedById: TaskId }),
  removeDependency: Slot.fn({ taskId: TaskId, blockedById: TaskId }),
  getDependencies: Slot.fn({ taskId: TaskId }, Schema.Array(TaskId)),
})

const TaskMachineEvent = MEvent({
  Published: {
    event: AgentEvent,
  },
  Hydrate: {
    tasks: TaskListStateSchema.fields.tasks,
  },
  CreateTask: MEvent.reply(
    {
      sessionId: SessionId,
      branchId: BranchId,
      subject: Schema.String,
      description: Schema.optional(Schema.String),
      agentType: Schema.optional(Schema.String),
      prompt: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Unknown),
    },
    Task,
  ),
  GetTask: MEvent.reply(
    {
      taskId: TaskId,
    },
    Schema.NullOr(Task),
  ),
  ListTasks: MEvent.reply(
    {
      sessionId: SessionId,
      branchId: Schema.optional(BranchId),
    },
    Schema.Array(Task),
  ),
  UpdateTask: MEvent.reply(
    {
      taskId: TaskId,
      status: Schema.optional(TaskStatus),
      description: Schema.optional(Schema.NullOr(Schema.String)),
      owner: Schema.optional(Schema.NullOr(SessionId)),
      metadata: Schema.optional(Schema.NullOr(Schema.Unknown)),
    },
    Schema.NullOr(Task),
  ),
  RunTask: MEvent.reply(
    {
      taskId: TaskId,
    },
    TaskRunResult,
  ),
  StopTask: MEvent.reply(
    {
      taskId: TaskId,
    },
    Schema.NullOr(Task),
  ),
  DeleteTask: MEvent.reply(
    {
      taskId: TaskId,
    },
    Schema.Null,
  ),
  GetTaskOutput: MEvent.reply(
    {
      taskId: TaskId,
    },
    Schema.NullOr(TaskOutputSummary),
  ),
  AddDependency: MEvent.reply(
    {
      taskId: TaskId,
      blockedById: TaskId,
    },
    Schema.Null,
  ),
  RemoveDependency: MEvent.reply(
    {
      taskId: TaskId,
      blockedById: TaskId,
    },
    Schema.Null,
  ),
  GetDependencies: MEvent.reply(
    {
      taskId: TaskId,
    },
    Schema.Array(TaskId),
  ),
})

const taskMachine = Machine.make({
  state: TaskMachineState,
  event: TaskMachineEvent,
  slots: TaskMachineSlots,
  initial: TaskMachineState.Active({ tasks: [] }),
})
  .onAny(TaskMachineEvent.Published, ({ state, event }) =>
    TaskMachineState.Active({
      tasks: reduce({ tasks: state.tasks }, event.event, {} as never).state.tasks,
    }),
  )
  .onAny(TaskMachineEvent.Hydrate, ({ event }) => TaskMachineState.Active({ tasks: event.tasks }))
  .on(TaskMachineState.Active, TaskMachineEvent.CreateTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.createTask({
        sessionId: event.sessionId,
        branchId: event.branchId,
        subject: event.subject,
        description: event.description,
        agentType: event.agentType,
        prompt: event.prompt,
        cwd: event.cwd,
        metadata: event.metadata,
      })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.GetTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.getTask({ taskId: event.taskId })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.ListTasks, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.listTasks({
        sessionId: event.sessionId,
        branchId: event.branchId,
      })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.UpdateTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const { taskId, ...fields } = event
      const reply = yield* slots.updateTask({ taskId, ...fields })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.RunTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.runTask({ taskId: event.taskId })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.StopTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.stopTask({ taskId: event.taskId })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.DeleteTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      yield* slots.deleteTask({ taskId: event.taskId })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), null)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.GetTaskOutput, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.getTaskOutput({ taskId: event.taskId })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.AddDependency, ({ state, event, slots }) =>
    Effect.gen(function* () {
      yield* slots.addDependency({ taskId: event.taskId, blockedById: event.blockedById })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), null)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.RemoveDependency, ({ state, event, slots }) =>
    Effect.gen(function* () {
      yield* slots.removeDependency({ taskId: event.taskId, blockedById: event.blockedById })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), null)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.GetDependencies, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.getDependencies({ taskId: event.taskId })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), reply)
    }),
  )

const provideTaskMachineSlots = Effect.gen(function* () {
  const taskService = yield* TaskService
  const taskStorage = yield* TaskStorage
  const runtimeDeps = yield* Effect.services<TaskRuntimeDeps>()
  const run = <A, E>(effect: Effect.Effect<A, E, TaskRuntimeDeps>) =>
    effect.pipe(Effect.provideServices(runtimeDeps))

  return {
    hydrateTasks: ({ sessionId }) => run(taskStorage.listTasks(sessionId).pipe(Effect.orDie)),
    createTask: (params) => run(taskService.create(params)),
    getTask: ({ taskId }) => run(taskService.get(taskId)).pipe(Effect.map((task) => task ?? null)),
    listTasks: ({ sessionId, branchId }) => run(taskService.list(sessionId, branchId)),
    updateTask: ({ taskId, ...fields }) =>
      run(taskService.update(taskId, fields).pipe(Effect.orDie)).pipe(
        Effect.map((task) => task ?? null),
      ),
    runTask: ({ taskId }) => run(taskService.run(taskId)),
    stopTask: ({ taskId }) =>
      run(taskService.stop(taskId)).pipe(Effect.map((task) => task ?? null)),
    deleteTask: ({ taskId }) => run(taskService.remove(taskId)),
    getTaskOutput: ({ taskId }) =>
      run(taskService.getOutput(taskId)).pipe(
        Effect.map((output) =>
          output === undefined
            ? null
            : {
                status: output.status,
                messageCount: output.messages.length,
                messages: output.messages.map((m) => {
                  const excerpt = m.parts
                    .filter((part): part is { type: "text"; text: string } => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                    .slice(0, 200)
                  return { role: m.role, excerpt }
                }),
              },
        ),
      ),
    addDependency: ({ taskId, blockedById }) => run(taskService.addDep(taskId, blockedById)),
    removeDependency: ({ taskId, blockedById }) => run(taskService.removeDep(taskId, blockedById)),
    getDependencies: ({ taskId }) => run(taskService.getDeps(taskId)),
  } satisfies ProvideSlots<typeof TaskMachineSlots.definitions>
})

const taskListActor: ExtensionActorDefinition<
  typeof TaskMachineState.Type,
  typeof TaskMachineEvent.Type,
  TaskStorage | TaskService | TaskRuntimeDeps,
  typeof TaskMachineSlots.definitions
> = {
  machine: taskMachine,
  slots: () => provideTaskMachineSlots,
  mapEvent: (event) => TaskMachineEvent.Published({ event }),
  mapRequest: (message) => {
    if (message.extensionId !== TASK_TOOLS_EXTENSION_ID) return undefined
    switch (message._tag) {
      case "CreateTask": {
        const request = message as ReturnType<typeof TaskProtocol.CreateTask>
        return TaskMachineEvent.CreateTask(request)
      }
      case "GetTask": {
        const request = message as ReturnType<typeof TaskProtocol.GetTask>
        return TaskMachineEvent.GetTask(request)
      }
      case "ListTasks": {
        const request = message as ReturnType<typeof TaskProtocol.ListTasks>
        return TaskMachineEvent.ListTasks(request)
      }
      case "UpdateTask": {
        const request = message as ReturnType<typeof TaskProtocol.UpdateTask>
        return TaskMachineEvent.UpdateTask(request)
      }
      case "RunTask": {
        const request = message as ReturnType<typeof TaskProtocol.RunTask>
        return TaskMachineEvent.RunTask(request)
      }
      case "StopTask": {
        const request = message as ReturnType<typeof TaskProtocol.StopTask>
        return TaskMachineEvent.StopTask(request)
      }
      case "DeleteTask": {
        const request = message as ReturnType<typeof TaskProtocol.DeleteTask>
        return TaskMachineEvent.DeleteTask(request)
      }
      case "GetTaskOutput": {
        const request = message as ReturnType<typeof TaskProtocol.GetTaskOutput>
        return TaskMachineEvent.GetTaskOutput(request)
      }
      case "AddDependency": {
        const request = message as ReturnType<typeof TaskProtocol.AddDependency>
        return TaskMachineEvent.AddDependency(request)
      }
      case "RemoveDependency": {
        const request = message as ReturnType<typeof TaskProtocol.RemoveDependency>
        return TaskMachineEvent.RemoveDependency(request)
      }
      case "GetDependencies": {
        const request = message as ReturnType<typeof TaskProtocol.GetDependencies>
        return TaskMachineEvent.GetDependencies(request)
      }
    }
  },
  snapshot: {
    schema: TaskListStateSchema,
    project: (state) => ({ tasks: state.tasks }),
  },
  onInit: ({ sessionId, send, slots }) =>
    Effect.gen(function* () {
      if (slots === undefined) return
      const tasks = yield* slots.hydrateTasks({ sessionId })
      if (tasks.length === 0) return
      yield* send(
        TaskMachineEvent.Hydrate({
          tasks: tasks.map((t) => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
          })),
        }),
      )
    }),
}

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
