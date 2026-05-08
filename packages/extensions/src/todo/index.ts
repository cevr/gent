/**
 * @gent/todo — durable todo list extension.
 *
 * Composition:
 *   - Tools (todo_create / todo_list / todo_get / todo_update) for the LLM
 *   - Requests: TodoGet, TodoList, TodoGetDeps, TodoCreate, TodoUpdate,
 *     TodoDelete, TodoAddDep, TodoRemoveDep
 *   - Layer: TodoStorage.Live + TodoService.Live
 *
 * The extension has no actor. LLM tools yield `TodoService` directly; typed
 * request capabilities remain the public/client transport surface.
 *
 * @module
 */
import { Layer } from "effect"
import { defineExtension, defineResource } from "@gent/core/extensions/api"
import { TodoCreateTool } from "./todo-create.js"
import { TodoListTool } from "./todo-list.js"
import { TodoGetTool } from "./todo-get.js"
import { TodoUpdateTool } from "./todo-update.js"
import { TodoStorage } from "../todo-storage.js"
import { TodoService } from "../todo-service.js"
import { TODO_EXTENSION_ID } from "./identity.js"
import {
  TodoGetRequest,
  TodoListRequest,
  TodoGetDepsRequest,
  TodoCreateRequest,
  TodoUpdateRequest,
  TodoDeleteRequest,
  TodoAddDepRequest,
  TodoRemoveDepRequest,
} from "./requests.js"

export type { TodoEntry } from "./identity.js"

export const TodoExtension = defineExtension({
  id: TODO_EXTENSION_ID,
  tools: [TodoCreateTool, TodoListTool, TodoGetTool, TodoUpdateTool],
  requests: [
    TodoGetRequest,
    TodoListRequest,
    TodoGetDepsRequest,
    TodoCreateRequest,
    TodoUpdateRequest,
    TodoDeleteRequest,
    TodoAddDepRequest,
    TodoRemoveDepRequest,
  ],
  resources: [
    defineResource({
      scope: "process",
      layer: Layer.mergeAll(TodoStorage.Live, TodoService.Live),
    }),
  ],
})
