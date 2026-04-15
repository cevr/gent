import { Effect, Layer, Schema } from "effect"
import { Event as MEvent, Machine, Slot, State as MState, type ProvideSlots } from "effect-machine"
import {
  extension,
  AgentEvent,
  Task,
  TaskStatus,
  BranchId,
  SessionId,
  TaskId,
  EventPublisher,
  type ExtensionActorDefinition,
  type ExtensionReduceContext,
  type ReduceResult,
} from "../api.js"
import { TaskCreateTool } from "./task-create.js"
import { TaskListTool } from "./task-list.js"
import { TaskGetTool } from "./task-get.js"
import { TaskUpdateTool } from "./task-update.js"
import { TaskStorage } from "../task-tools-storage.js"
import { TaskService } from "../task-tools-service.js"
import { TASK_TOOLS_EXTENSION_ID, TaskProtocol, TaskUiModel } from "../task-tools-protocol.js"

// ── Task list actor — projects task state as extension UI snapshot ──

export type { TaskEntry } from "../task-tools-protocol.js"
import type { TaskEntry } from "../task-tools-protocol.js"

export interface TaskListState {
  readonly tasks: ReadonlyArray<TaskEntry>
}

const TaskListStateSchema = TaskUiModel

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
  deleteTask: Slot.fn({ taskId: TaskId }),
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
  DeleteTask: MEvent.reply(
    {
      taskId: TaskId,
    },
    Schema.Null,
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
  .on(TaskMachineState.Active, TaskMachineEvent.DeleteTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      yield* slots.deleteTask({ taskId: event.taskId })
      return Machine.reply(TaskMachineState.Active({ tasks: state.tasks }), null)
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
  const eventPublisher = yield* EventPublisher

  return {
    hydrateTasks: ({ sessionId }) => taskStorage.listTasks(sessionId).pipe(Effect.orDie),
    createTask: (params) =>
      taskService.create(params).pipe(Effect.provideService(EventPublisher, eventPublisher)),
    getTask: ({ taskId }) => taskService.get(taskId).pipe(Effect.map((task) => task ?? null)),
    listTasks: ({ sessionId, branchId }) => taskService.list(sessionId, branchId),
    updateTask: ({ taskId, ...fields }) =>
      taskService.update(taskId, fields).pipe(
        Effect.orDie,
        Effect.provideService(EventPublisher, eventPublisher),
        Effect.map((task) => task ?? null),
      ),
    deleteTask: ({ taskId }) =>
      taskService.remove(taskId).pipe(Effect.provideService(EventPublisher, eventPublisher)),
    addDependency: ({ taskId, blockedById }) => taskService.addDep(taskId, blockedById),
    removeDependency: ({ taskId, blockedById }) => taskService.removeDep(taskId, blockedById),
    getDependencies: ({ taskId }) => taskService.getDeps(taskId),
  } satisfies ProvideSlots<typeof TaskMachineSlots.definitions>
})

const taskListActor: ExtensionActorDefinition<
  typeof TaskMachineState.Type,
  typeof TaskMachineEvent.Type,
  TaskStorage | TaskService | EventPublisher,
  typeof TaskMachineSlots.definitions
> = {
  machine: taskMachine,
  slots: () => provideTaskMachineSlots,
  mapEvent: (event) => TaskMachineEvent.Published({ event }),
  mapRequest: (message) => {
    if (TaskProtocol.CreateTask.is(message)) return TaskMachineEvent.CreateTask(message)
    if (TaskProtocol.GetTask.is(message)) return TaskMachineEvent.GetTask(message)
    if (TaskProtocol.ListTasks.is(message)) return TaskMachineEvent.ListTasks(message)
    if (TaskProtocol.UpdateTask.is(message)) return TaskMachineEvent.UpdateTask(message)
    if (TaskProtocol.DeleteTask.is(message)) return TaskMachineEvent.DeleteTask(message)
    if (TaskProtocol.AddDependency.is(message)) return TaskMachineEvent.AddDependency(message)
    if (TaskProtocol.RemoveDependency.is(message)) return TaskMachineEvent.RemoveDependency(message)
    if (TaskProtocol.GetDependencies.is(message)) return TaskMachineEvent.GetDependencies(message)
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
  protocols: TaskProtocol,
}

// ── Extension ──

export const TaskExtension = extension("@gent/task-tools", ({ ext }) =>
  ext
    .tools(TaskCreateTool, TaskListTool, TaskGetTool, TaskUpdateTool)
    .layer(Layer.merge(TaskStorage.Live, TaskService.Live))
    .actor(taskListActor),
)
