/**
 * @gent/task-tools — durable task list extension.
 *
 * Composition:
 *   - Tools (task_create / task_list / task_get / task_update) for the LLM
 *   - TaskProjection — derives UI snapshot from TaskStorage on demand
 *   - Queries: TaskGet, TaskList, TaskGetDeps
 *   - Mutations: TaskCreate, TaskUpdate, TaskDelete, TaskAddDep, TaskRemoveDep
 *   - Layer: TaskStorage.Live + TaskService.Live
 *
 * The extension has NO actor. The legacy `TaskProtocol` actor (which was a
 * pure RPC dispatcher mapping ExtensionMessage.reply requests to TaskService
 * calls) has been replaced with typed Query/Mutation contributions consumed
 * via `ctx.extension.query(ref, input)` / `ctx.extension.mutate(ref, input)`.
 *
 * @module
 */
import { Layer } from "effect"
import { extension } from "@gent/core/extensions/api"
import { TaskCreateTool } from "./task-create.js"
import { TaskListTool } from "./task-list.js"
import { TaskGetTool } from "./task-get.js"
import { TaskUpdateTool } from "./task-update.js"
import { TaskStorage } from "../task-tools-storage.js"
import { TaskService } from "../task-tools-service.js"
import { TaskProjection } from "./projection.js"
import { TASK_TOOLS_EXTENSION_ID } from "./identity.js"
import { TaskGetQuery, TaskListQuery, TaskGetDepsQuery } from "./queries.js"
import {
  TaskCreateMutation,
  TaskUpdateMutation,
  TaskDeleteMutation,
  TaskAddDepMutation,
  TaskRemoveDepMutation,
} from "./mutations.js"

export type { TaskEntry } from "./identity.js"

export const TaskExtension = extension(TASK_TOOLS_EXTENSION_ID, ({ ext }) =>
  ext
    .tools(TaskCreateTool, TaskListTool, TaskGetTool, TaskUpdateTool)
    .layer(Layer.merge(TaskStorage.Live, TaskService.Live))
    .projection(TaskProjection)
    .query(TaskGetQuery)
    .query(TaskListQuery)
    .query(TaskGetDepsQuery)
    .mutation(TaskCreateMutation)
    .mutation(TaskUpdateMutation)
    .mutation(TaskDeleteMutation)
    .mutation(TaskAddDepMutation)
    .mutation(TaskRemoveDepMutation),
)
