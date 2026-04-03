import { ServiceMap, DateTime, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import {
  Task,
  TaskTransitionError,
  isValidTaskTransition,
  type TaskStatus,
} from "../domain/task.js"
import {
  EventStore,
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskStopped,
  TaskDeleted,
  type AgentRunSpawned,
} from "../domain/event.js"
import { AgentRunnerService, type AgentName } from "../domain/agent.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import type { TaskId, SessionId, BranchId, ToolCallId } from "../domain/ids.js"
import { TaskStorage, type TaskStorageService } from "./task-tools-storage.js"
import { Storage } from "../storage/sqlite-storage.js"
import type { Message } from "../domain/message.js"

// Extension-owned task service. Present only when @gent/task-tools is loaded.

export type TaskRuntimeDeps = EventStore | ExtensionRegistry | RuntimePlatform | Storage
type TaskServiceFallbackApi = {
  readonly create: (params: {
    sessionId: SessionId
    branchId: BranchId
    subject: string
    description?: string
    agentType?: AgentName
    prompt?: string
    cwd?: string
    metadata?: unknown
  }) => Effect.Effect<Task>
  readonly get: (id: TaskId) => Effect.Effect<Task | undefined>
  readonly list: (sessionId: SessionId, branchId?: BranchId) => Effect.Effect<ReadonlyArray<Task>>
  readonly update: (
    id: TaskId,
    fields: Partial<{
      status: TaskStatus
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<Task | undefined>
  readonly remove: (id: TaskId) => Effect.Effect<void>
  readonly run: (id: TaskId) => Effect.Effect<{
    taskId: TaskId
    status: string
    sessionId?: SessionId
    branchId?: BranchId
  }>
  readonly stop: (id: TaskId) => Effect.Effect<Task | undefined>
  readonly getOutput: (id: TaskId) => Effect.Effect<
    | {
        messages: ReadonlyArray<Message>
        status: TaskStatus
      }
    | undefined
  >
  readonly addDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly removeDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly getDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>>
}

export interface TaskServiceApi {
  readonly create: (params: {
    sessionId: SessionId
    branchId: BranchId
    subject: string
    description?: string
    agentType?: AgentName
    prompt?: string
    cwd?: string
    metadata?: unknown
  }) => Effect.Effect<Task, never, TaskRuntimeDeps>

  readonly get: (id: TaskId) => Effect.Effect<Task | undefined, never, TaskRuntimeDeps>

  readonly list: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, never, TaskRuntimeDeps>

  readonly update: (
    id: TaskId,
    fields: Partial<{
      status: TaskStatus
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<Task | undefined, TaskTransitionError, TaskRuntimeDeps>

  readonly remove: (id: TaskId) => Effect.Effect<void, never, TaskRuntimeDeps>

  readonly run: (id: TaskId) => Effect.Effect<
    {
      taskId: TaskId
      status: string
      sessionId?: SessionId
      branchId?: BranchId
    },
    never,
    TaskRuntimeDeps
  >

  readonly stop: (id: TaskId) => Effect.Effect<Task | undefined, never, TaskRuntimeDeps>

  readonly getOutput: (id: TaskId) => Effect.Effect<
    | {
        messages: ReadonlyArray<Message>
        status: TaskStatus
      }
    | undefined,
    never,
    TaskRuntimeDeps
  >

  readonly addDep: (
    taskId: TaskId,
    blockedById: TaskId,
  ) => Effect.Effect<void, never, TaskRuntimeDeps>
  readonly removeDep: (
    taskId: TaskId,
    blockedById: TaskId,
  ) => Effect.Effect<void, never, TaskRuntimeDeps>
  readonly getDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>, never, TaskRuntimeDeps>
}

export class TaskService extends ServiceMap.Service<TaskService, TaskServiceApi>()(
  "@gent/core/src/extensions/task-tools-service/TaskService",
) {
  /** No-op TaskService returned when @gent/task-tools is disabled (TaskStorage absent) */
  private static readonly Noop: TaskServiceFallbackApi = {
    create: () => Effect.die("TaskStorage not available — @gent/task-tools is disabled"),
    get: () => Effect.void as Effect.Effect<Task | undefined>,
    list: () => Effect.succeed([] as ReadonlyArray<Task>),
    update: () => Effect.void as Effect.Effect<Task | undefined>,
    remove: () => Effect.void,
    run: (id) => Effect.succeed({ taskId: id, status: "not_found" }),
    stop: () => Effect.void as Effect.Effect<Task | undefined>,
    getOutput: () =>
      Effect.void as Effect.Effect<
        { messages: ReadonlyArray<Message>; status: TaskStatus } | undefined
      >,
    addDep: () => Effect.void,
    removeDep: () => Effect.void,
    getDeps: () => Effect.succeed([]),
  }

  static Live: Layer.Layer<TaskService> = Layer.effect(
    TaskService,
    Effect.gen(function* () {
      const fiberMap = yield* Ref.make(new Map<TaskId, Fiber.Fiber<void>>())

      /** Merge new metadata fields into existing task metadata without clobbering */
      const mergeMetadata = (existing: unknown, patch: Record<string, unknown>): unknown => {
        const base = typeof existing === "object" && existing !== null ? existing : {}
        return { ...base, ...patch }
      }

      const getRuntimeDeps = Effect.gen(function* () {
        return {
          eventStore: yield* EventStore,
          extensionRegistry: yield* ExtensionRegistry,
          platform: yield* RuntimePlatform,
          mainStorage: yield* Storage,
        }
      })

      const forkTask = <R>(taskId: TaskId, effect: Effect.Effect<void, never, R>) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            effect.pipe(
              Effect.ensuring(
                Ref.update(fiberMap, (m) => {
                  const next = new Map(m)
                  next.delete(taskId)
                  return next
                }),
              ),
            ),
          )
          yield* Ref.update(fiberMap, (m) => {
            const next = new Map(m)
            next.set(taskId, fiber)
            return next
          })
        })

      const runTaskInternal: (
        storage: TaskStorageService,
        taskId: TaskId,
        task: Task,
      ) => Effect.Effect<void, never, TaskRuntimeDeps> = (storage, taskId, task) =>
        Effect.gen(function* () {
          const { eventStore, extensionRegistry, platform } = yield* getRuntimeDeps
          const agent = yield* extensionRegistry.getAgent(task.agentType ?? "explore")
          if (agent === undefined) {
            yield* storage
              .updateTask(taskId, { status: "failed" })
              .pipe(Effect.catchEager(() => Effect.void))
            yield* eventStore
              .publish(
                new TaskFailed({
                  sessionId: task.sessionId,
                  branchId: task.branchId,
                  taskId,
                  error: `Unknown agent: ${task.agentType}`,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))
            return
          }

          // Status already set to in_progress by run() before forking
          const parentSessionId = task.sessionId
          const parentBranchId = task.branchId
          const runnerOpt = yield* Effect.serviceOption(AgentRunnerService)
          if (runnerOpt._tag === "None") {
            const error = "AgentRunnerService not available"
            yield* storage
              .updateTask(taskId, {
                status: "failed",
                metadata: mergeMetadata(task.metadata, { error }),
              })
              .pipe(Effect.catchEager(() => Effect.void))
            yield* eventStore
              .publish(
                new TaskFailed({
                  sessionId: parentSessionId,
                  branchId: parentBranchId,
                  taskId,
                  error,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))
            return
          }
          const runner = runnerOpt.value

          // Synthetic toolCallId for correlation — concurrent tasks each get their own
          const taskToolCallId = `task:${taskId}` as ToolCallId

          // Capture child sessionId + track progress from child session events
          const startedAt = yield* DateTime.nowAsDate
          const progressState = { toolCount: 0, tokenCount: 0, startedAt: startedAt.getTime() }
          const captureAndTrack = eventStore
            .subscribe({ sessionId: parentSessionId, branchId: parentBranchId })
            .pipe(
              Stream.filter(
                (env) =>
                  env.event._tag === "AgentRunSpawned" &&
                  (env.event as AgentRunSpawned).toolCallId === taskToolCallId,
              ),
              Stream.take(1),
              Stream.runForEach((env) => {
                const spawned = env.event as AgentRunSpawned
                return Effect.gen(function* () {
                  // Store child sessionId immediately
                  yield* storage
                    .updateTask(taskId, {
                      metadata: { childSessionId: spawned.childSessionId, progress: progressState },
                    })
                    .pipe(Effect.catchEager(() => Effect.void))

                  // Subscribe to child session events for progress tracking
                  yield* eventStore.subscribe({ sessionId: spawned.childSessionId }).pipe(
                    Stream.runForEach((childEnv) =>
                      Effect.gen(function* () {
                        const e = childEnv.event
                        let updated = false
                        if (e._tag === "ToolCallSucceeded" || e._tag === "ToolCallFailed") {
                          progressState.toolCount++
                          updated = true
                        }
                        if (e._tag === "StreamEnded" && e.usage !== undefined) {
                          progressState.tokenCount +=
                            (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0)
                          updated = true
                        }
                        if (updated) {
                          yield* storage
                            .updateTask(taskId, {
                              metadata: {
                                childSessionId: spawned.childSessionId,
                                progress: progressState,
                              },
                            })
                            .pipe(Effect.catchEager(() => Effect.void))
                        }
                      }),
                    ),
                    Effect.catchEager(() => Effect.void),
                  )
                })
              }),
              Effect.catchEager(() => Effect.void),
            )

          const childCaptureFiber = yield* Effect.forkChild(captureAndTrack)

          // Run subagent — toolCallId correlates AgentRunSpawned to this specific task
          const result = yield* runner.run({
            agent,
            prompt: task.prompt ?? task.subject,
            parentSessionId,
            parentBranchId,
            toolCallId: taskToolCallId,
            cwd: task.cwd ?? platform.cwd,
            persistence: "durable",
          })

          // Clean up the event capture fiber
          yield* Fiber.interrupt(childCaptureFiber).pipe(Effect.catchEager(() => Effect.void))

          // Guard: if stop() raced and already set terminal state, don't overwrite
          const currentTask = yield* storage
            .getTask(taskId)
            .pipe(Effect.catchEager(() => Effect.void as Effect.Effect<Task | undefined>))
          if (currentTask?.status === "stopped") return

          if (result._tag === "success") {
            const existingMeta = currentTask?.metadata
            yield* storage
              .updateTask(taskId, {
                status: "completed",
                owner: result.sessionId,
                metadata: mergeMetadata(existingMeta, { childSessionId: result.sessionId }),
              })
              .pipe(Effect.catchEager(() => Effect.void))
            yield* eventStore
              .publish(
                new TaskCompleted({
                  sessionId: parentSessionId,
                  branchId: parentBranchId,
                  taskId,
                  owner: result.sessionId,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))

            // Check dependent tasks for auto-run
            yield* checkAndRunDependents(storage, taskId).pipe(Effect.catchEager(() => Effect.void))
          } else {
            yield* storage
              .updateTask(taskId, {
                status: "failed",
                metadata: mergeMetadata(currentTask?.metadata, { error: result.error }),
              })
              .pipe(Effect.catchEager(() => Effect.void))
            yield* eventStore
              .publish(
                new TaskFailed({
                  sessionId: parentSessionId,
                  branchId: parentBranchId,
                  taskId,
                  error: result.error,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))
          }
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              const { eventStore } = yield* getRuntimeDeps
              // Determine if this was a user-initiated stop or a shutdown interrupt
              const current = yield* storage
                .getTask(taskId)
                .pipe(Effect.catchEager(() => Effect.void as Effect.Effect<Task | undefined>))
              const alreadyStopped = current?.status === "stopped"

              if (!alreadyStopped) {
                yield* storage
                  .updateTask(taskId, { status: "stopped" })
                  .pipe(Effect.catchEager(() => Effect.void))
                yield* eventStore
                  .publish(
                    new TaskStopped({
                      sessionId: task.sessionId,
                      branchId: task.branchId,
                      taskId,
                    }),
                  )
                  .pipe(Effect.catchEager(() => Effect.void))
              }

              // Remove from fiber map
              yield* Ref.update(fiberMap, (m) => {
                const next = new Map(m)
                next.delete(taskId)
                return next
              })

              // Unblock dependents (stopped is terminal like failed)
              yield* checkAndRunDependents(storage, taskId).pipe(
                Effect.catchEager(() => Effect.void),
              )
            }),
          ),
          Effect.catchEager(() => Effect.void),
        )

      const checkAndRunDependents: (
        storage: TaskStorageService,
        completedTaskId: TaskId,
      ) => Effect.Effect<void, never, TaskRuntimeDeps> = (storage, completedTaskId) =>
        Effect.gen(function* () {
          const { eventStore } = yield* getRuntimeDeps
          const dependents = yield* storage.getTaskDependents(completedTaskId)
          for (const depTaskId of dependents) {
            const depTask = yield* storage.getTask(depTaskId)
            if (depTask === undefined || depTask.status !== "pending") continue
            if (depTask.agentType === undefined || depTask.prompt === undefined) continue

            // Check if all blockers are done
            const blockers = yield* storage.getTaskDeps(depTaskId)
            const allDone = yield* Effect.forEach(blockers, (blockerId) =>
              storage
                .getTask(blockerId)
                .pipe(
                  Effect.map(
                    (t) =>
                      t === undefined ||
                      t.status === "completed" ||
                      t.status === "failed" ||
                      t.status === "stopped",
                  ),
                ),
            )
            if (allDone.every(Boolean)) {
              // Atomically claim: compare-and-set pending→in_progress
              const claimed = yield* storage
                .claimTask(depTaskId)
                .pipe(Effect.catchEager(() => Effect.sync(() => undefined as Task | undefined)))
              if (claimed === undefined) continue
              yield* eventStore
                .publish(
                  new TaskUpdated({
                    sessionId: claimed.sessionId,
                    branchId: claimed.branchId,
                    taskId: depTaskId,
                    status: "in_progress",
                  }),
                )
                .pipe(Effect.catchEager(() => Effect.void))
              yield* forkTask(depTaskId, runTaskInternal(storage, depTaskId, depTask))
            }
          }
        }).pipe(Effect.catchEager(() => Effect.void))

      return {
        create: (params) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.create(params),
                onSome: (storage: TaskStorageService) =>
                  Effect.gen(function* () {
                    const { eventStore } = yield* getRuntimeDeps
                    const id = Bun.randomUUIDv7() as TaskId
                    const now = yield* DateTime.nowAsDate
                    const task = new Task({
                      id,
                      sessionId: params.sessionId,
                      branchId: params.branchId,
                      subject: params.subject,
                      description: params.description,
                      status: "pending",
                      agentType: params.agentType,
                      prompt: params.prompt,
                      cwd: params.cwd,
                      metadata: params.metadata,
                      createdAt: now,
                      updatedAt: now,
                    })
                    yield* storage.createTask(task)
                    yield* eventStore.publish(
                      new TaskCreated({
                        sessionId: params.sessionId,
                        branchId: params.branchId,
                        taskId: id,
                        subject: params.subject,
                      }),
                    )
                    return task
                  }).pipe(Effect.orDie),
              }),
            ),
          ),

        get: (id) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.get(id),
                onSome: (storage: TaskStorageService) => storage.getTask(id).pipe(Effect.orDie),
              }),
            ),
          ),

        list: (sessionId, branchId) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.list(sessionId, branchId),
                onSome: (storage: TaskStorageService) =>
                  storage.listTasks(sessionId, branchId).pipe(Effect.orDie),
              }),
            ),
          ),

        update: (id, fields) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.update(id, fields),
                onSome: (storage: TaskStorageService) =>
                  Effect.gen(function* () {
                    const { eventStore } = yield* getRuntimeDeps
                    // Validate status transition if status is being changed
                    if (fields.status !== undefined) {
                      const existing = yield* storage.getTask(id)
                      if (
                        existing !== undefined &&
                        !isValidTaskTransition(existing.status, fields.status)
                      ) {
                        return yield* new TaskTransitionError({
                          message: `Invalid task transition: ${existing.status} → ${fields.status}`,
                          from: existing.status,
                          to: fields.status,
                        })
                      }
                    }
                    const updated = yield* storage.updateTask(id, fields)
                    if (updated !== undefined && fields.status !== undefined) {
                      if (fields.status === "completed") {
                        yield* eventStore.publish(
                          new TaskCompleted({
                            sessionId: updated.sessionId,
                            branchId: updated.branchId,
                            taskId: id,
                            owner: updated.owner,
                          }),
                        )
                      } else if (fields.status === "failed") {
                        const error =
                          updated.metadata !== null &&
                          updated.metadata !== undefined &&
                          typeof updated.metadata === "object" &&
                          "error" in updated.metadata &&
                          typeof updated.metadata.error === "string"
                            ? updated.metadata.error
                            : undefined
                        yield* eventStore.publish(
                          new TaskFailed({
                            sessionId: updated.sessionId,
                            branchId: updated.branchId,
                            taskId: id,
                            ...(error !== undefined ? { error } : {}),
                          }),
                        )
                      } else {
                        yield* eventStore.publish(
                          new TaskUpdated({
                            sessionId: updated.sessionId,
                            branchId: updated.branchId,
                            taskId: id,
                            status: fields.status,
                          }),
                        )
                      }
                    }
                    return updated
                  }).pipe(Effect.orDie),
              }),
            ),
          ),

        remove: (id) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.remove(id),
                onSome: (storage: TaskStorageService) =>
                  Effect.gen(function* () {
                    const { eventStore } = yield* getRuntimeDeps
                    const existing = yield* storage.getTask(id).pipe(Effect.orDie)
                    if (existing === undefined) {
                      yield* storage.deleteTask(id).pipe(Effect.orDie)
                      return
                    }
                    yield* storage.deleteTask(id).pipe(Effect.orDie)
                    yield* eventStore
                      .publish(
                        new TaskDeleted({
                          sessionId: existing.sessionId,
                          branchId: existing.branchId,
                          taskId: id,
                        }),
                      )
                      .pipe(Effect.catchEager(() => Effect.void))
                  }),
              }),
            ),
          ),

        run: (id) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.run(id),
                onSome: (storage: TaskStorageService) =>
                  Effect.gen(function* () {
                    const { eventStore } = yield* getRuntimeDeps
                    const task = yield* storage.getTask(id).pipe(Effect.orDie)
                    if (task === undefined) {
                      return { taskId: id, status: "not_found" }
                    }
                    if (task.status !== "pending") {
                      return { taskId: id, status: task.status }
                    }

                    // Atomically claim before forking — compare-and-set prevents double-run
                    const claimed = yield* storage.claimTask(id).pipe(Effect.orDie)
                    if (claimed === undefined) {
                      return { taskId: id, status: task.status }
                    }
                    yield* eventStore
                      .publish(
                        new TaskUpdated({
                          sessionId: claimed.sessionId,
                          branchId: claimed.branchId,
                          taskId: id,
                          status: "in_progress",
                        }),
                      )
                      .pipe(Effect.catchEager(() => Effect.void))

                    yield* forkTask(id, runTaskInternal(storage, id, claimed))
                    return { taskId: id, status: "running" }
                  }),
              }),
            ),
          ),

        stop: (id) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.stop(id),
                onSome: (storage: TaskStorageService) =>
                  Effect.gen(function* () {
                    const { eventStore } = yield* getRuntimeDeps
                    const task = yield* storage.getTask(id).pipe(Effect.orDie)
                    if (task === undefined) return undefined
                    if (task.status !== "in_progress" && task.status !== "pending") return task

                    // Set stopped in storage first (so onInterrupt sees it)
                    const updated = yield* storage
                      .updateTask(id, { status: "stopped" })
                      .pipe(Effect.orDie)

                    yield* eventStore
                      .publish(
                        new TaskStopped({
                          sessionId: task.sessionId,
                          branchId: task.branchId,
                          taskId: id,
                        }),
                      )
                      .pipe(Effect.catchEager(() => Effect.void))

                    // Interrupt fiber if running
                    const fibers = yield* Ref.get(fiberMap)
                    const fiber = fibers.get(id)
                    if (fiber !== undefined) {
                      yield* Fiber.interrupt(fiber).pipe(Effect.catchEager(() => Effect.void))
                    }

                    // Unblock dependents
                    yield* checkAndRunDependents(storage, id).pipe(
                      Effect.catchEager(() => Effect.void),
                    )

                    return updated
                  }),
              }),
            ),
          ),

        getOutput: (id) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.getOutput(id),
                onSome: (storage: TaskStorageService) =>
                  Effect.gen(function* () {
                    const { mainStorage } = yield* getRuntimeDeps
                    const task = yield* storage.getTask(id).pipe(Effect.orDie)
                    if (task === undefined) return undefined

                    // Child session stored in metadata.childSessionId or fallback to task.owner
                    const meta = task.metadata as { childSessionId?: string } | undefined
                    const childSessionId = (meta?.childSessionId ?? task.owner) as
                      | SessionId
                      | undefined
                    if (childSessionId === undefined) {
                      return { messages: [] as ReadonlyArray<Message>, status: task.status }
                    }

                    const branches = yield* mainStorage
                      .listBranches(childSessionId)
                      .pipe(Effect.catchEager(() => Effect.succeed([] as const)))

                    const branch = branches[0]
                    if (branch === undefined) {
                      return { messages: [] as ReadonlyArray<Message>, status: task.status }
                    }

                    const messages = yield* mainStorage
                      .listMessages(branch.id)
                      .pipe(Effect.catchEager(() => Effect.succeed([] as ReadonlyArray<Message>)))

                    return { messages, status: task.status }
                  }),
              }),
            ),
          ),

        addDep: (taskId, blockedById) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.addDep(taskId, blockedById),
                onSome: (storage: TaskStorageService) =>
                  storage.addTaskDep(taskId, blockedById).pipe(Effect.orDie),
              }),
            ),
          ),
        removeDep: (taskId, blockedById) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.removeDep(taskId, blockedById),
                onSome: (storage: TaskStorageService) =>
                  storage.removeTaskDep(taskId, blockedById).pipe(Effect.orDie),
              }),
            ),
          ),
        getDeps: (taskId) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => TaskService.Noop.getDeps(taskId),
                onSome: (storage: TaskStorageService) =>
                  storage.getTaskDeps(taskId).pipe(Effect.orDie),
              }),
            ),
          ),
      }
    }),
  )

  static Test = (): Layer.Layer<TaskService> => Layer.succeed(TaskService, TaskService.Noop)
}
