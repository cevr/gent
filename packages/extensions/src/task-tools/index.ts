import { Effect, Layer, Schema } from "effect"
import { Event as MEvent, Machine, Slot, State as MState, type ProvideSlots } from "effect-machine"
import {
  extension,
  Task,
  TaskStatus,
  BranchId,
  SessionId,
  TaskId,
  EventPublisher,
  type ExtensionActorDefinition,
} from "@gent/core/extensions/api"
import { TaskCreateTool } from "./task-create.js"
import { TaskListTool } from "./task-list.js"
import { TaskGetTool } from "./task-get.js"
import { TaskUpdateTool } from "./task-update.js"
import { TaskStorage } from "../task-tools-storage.js"
import { TaskService } from "../task-tools-service.js"
import { TASK_TOOLS_EXTENSION_ID, TaskProtocol } from "../task-tools-protocol.js"
import { TaskProjection } from "./projection.js"

// ── Task list actor — pure RPC dispatcher (CRUD via TaskProtocol) ──
//
// The UI snapshot side has moved to `TaskProjection` (./projection.ts), which
// queries `TaskStorage` directly. This actor no longer mirrors task events
// into local state — the source of truth is on-disk.
//
// Commit 4 will move this CRUD path to typed Query/Mutation contributions and
// delete the actor entirely.

export type { TaskEntry } from "../task-tools-protocol.js"

// Active is a marker state — the machine is a pure RPC dispatcher with no
// task-list mirror state. The `_marker` field is a placeholder (effect-machine
// requires non-empty struct fields). Snapshot is omitted from the actor (the
// projection emits the UI snapshot instead), so the marker is invisible.
const TaskMachineState = MState({
  Active: {
    _marker: Schema.Literal("rpc"),
  },
})

const TaskInstance = Schema.instanceOf(Task)
const NullableTaskInstance = Schema.NullOr(TaskInstance)
const TaskInstanceArray = Schema.Array(TaskInstance)

const TaskMachineSlots = Slot.define({
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
  initial: TaskMachineState.Active({ _marker: "rpc" as const }),
})
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
      return Machine.reply(state, reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.GetTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.getTask({ taskId: event.taskId })
      return Machine.reply(state, reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.ListTasks, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.listTasks({
        sessionId: event.sessionId,
        branchId: event.branchId,
      })
      return Machine.reply(state, reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.UpdateTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const { taskId, ...fields } = event
      const reply = yield* slots.updateTask({ taskId, ...fields })
      return Machine.reply(state, reply)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.DeleteTask, ({ state, event, slots }) =>
    Effect.gen(function* () {
      yield* slots.deleteTask({ taskId: event.taskId })
      return Machine.reply(state, null)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.AddDependency, ({ state, event, slots }) =>
    Effect.gen(function* () {
      yield* slots.addDependency({ taskId: event.taskId, blockedById: event.blockedById })
      return Machine.reply(state, null)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.RemoveDependency, ({ state, event, slots }) =>
    Effect.gen(function* () {
      yield* slots.removeDependency({ taskId: event.taskId, blockedById: event.blockedById })
      return Machine.reply(state, null)
    }),
  )
  .on(TaskMachineState.Active, TaskMachineEvent.GetDependencies, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const reply = yield* slots.getDependencies({ taskId: event.taskId })
      return Machine.reply(state, reply)
    }),
  )

const provideTaskMachineSlots = Effect.gen(function* () {
  const taskService = yield* TaskService
  const eventPublisher = yield* EventPublisher

  return {
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

const taskRpcActor: ExtensionActorDefinition<
  typeof TaskMachineState.Type,
  typeof TaskMachineEvent.Type,
  TaskService | EventPublisher,
  typeof TaskMachineSlots.definitions
> = {
  machine: taskMachine,
  slots: () => provideTaskMachineSlots,
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
  protocols: TaskProtocol,
}

// ── Extension ──

export const TaskExtension = extension(TASK_TOOLS_EXTENSION_ID, ({ ext }) =>
  ext
    .tools(TaskCreateTool, TaskListTool, TaskGetTool, TaskUpdateTool)
    .layer(Layer.merge(TaskStorage.Live, TaskService.Live))
    .actor(taskRpcActor)
    .projection(TaskProjection),
)
