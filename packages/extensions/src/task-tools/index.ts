/**
 * @gent/task-tools — durable task list extension.
 *
 * Composition:
 *   - Tools (task_create / task_list / task_get / task_update) for the LLM
 *   - Requests: TaskGet, TaskList, TaskGetDeps, TaskCreate, TaskUpdate,
 *     TaskDelete, TaskAddDep, TaskRemoveDep
 *   - Layer: TaskStorage.Live + TaskService.Live
 *
 * The extension has no actor. LLM tools yield `TaskService` directly; typed
 * request capabilities remain the public/client transport surface.
 *
 * @module
 */
import { Layer } from "effect"
import { defineExtension, defineResource } from "@gent/core/extensions/api"
import { TaskCreateTool } from "./task-create.js"
import { TaskListTool } from "./task-list.js"
import { TaskGetTool } from "./task-get.js"
import { TaskUpdateTool } from "./task-update.js"
import { TaskStorage } from "../task-tools-storage.js"
import { TaskService } from "../task-tools-service.js"
import { TASK_TOOLS_EXTENSION_ID } from "./identity.js"
import {
  TaskGetRequest,
  TaskListRequest,
  TaskGetDepsRequest,
  TaskCreateRequest,
  TaskUpdateRequest,
  TaskDeleteRequest,
  TaskAddDepRequest,
  TaskRemoveDepRequest,
} from "./requests.js"

export type { TaskEntry } from "./identity.js"

export const TaskExtension = defineExtension({
  id: TASK_TOOLS_EXTENSION_ID,
  tools: [TaskCreateTool, TaskListTool, TaskGetTool, TaskUpdateTool],
  rpc: [
    TaskGetRequest,
    TaskListRequest,
    TaskGetDepsRequest,
    TaskCreateRequest,
    TaskUpdateRequest,
    TaskDeleteRequest,
    TaskAddDepRequest,
    TaskRemoveDepRequest,
  ],
  resources: [
    defineResource({
      scope: "process",
      layer: Layer.merge(TaskStorage.Live, TaskService.Live),
    }),
  ],
})
