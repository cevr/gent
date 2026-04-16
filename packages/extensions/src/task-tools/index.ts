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
import {
  defineExtension,
  layerContribution,
  mutationContribution,
  projectionContribution,
  queryContribution,
  toolContribution,
} from "@gent/core/extensions/api"
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

export const TaskExtension = defineExtension({
  id: TASK_TOOLS_EXTENSION_ID,
  contributions: () => [
    toolContribution(TaskCreateTool),
    toolContribution(TaskListTool),
    toolContribution(TaskGetTool),
    toolContribution(TaskUpdateTool),
    layerContribution(Layer.merge(TaskStorage.Live, TaskService.Live)),
    projectionContribution(TaskProjection),
    queryContribution(TaskGetQuery),
    queryContribution(TaskListQuery),
    queryContribution(TaskGetDepsQuery),
    mutationContribution(TaskCreateMutation),
    mutationContribution(TaskUpdateMutation),
    mutationContribution(TaskDeleteMutation),
    mutationContribution(TaskAddDepMutation),
    mutationContribution(TaskRemoveDepMutation),
  ],
})
