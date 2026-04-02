import { describe, test, expect } from "effect-bun-test"
import {
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskStopped,
  TaskDeleted,
} from "@gent/core/domain/event"
import type { BranchId, SessionId, TaskId } from "@gent/core/domain/ids"
import { TaskListActorConfig, type TaskListState } from "@gent/core/extensions/task-tools"
import { createActorHarness } from "@gent/core/test-utils/extension-harness"

const sessionId = "tt-session" as SessionId
const branchId = "tt-branch" as BranchId

const mkTaskCreated = (taskId: string, subject: string) =>
  new TaskCreated({ sessionId, branchId, taskId: taskId as TaskId, subject })

const mkTaskUpdated = (taskId: string, status: string) =>
  new TaskUpdated({ sessionId, branchId, taskId: taskId as TaskId, status })

const mkTaskCompleted = (taskId: string) =>
  new TaskCompleted({ sessionId, branchId, taskId: taskId as TaskId })

const mkTaskFailed = (taskId: string) =>
  new TaskFailed({ sessionId, branchId, taskId: taskId as TaskId })

const mkTaskStopped = (taskId: string) =>
  new TaskStopped({ sessionId, branchId, taskId: taskId as TaskId })

const mkTaskDeleted = (taskId: string) =>
  new TaskDeleted({ sessionId, branchId, taskId: taskId as TaskId })

describe("TaskList pure reducer", () => {
  const { reduce, derive, events } = createActorHarness(TaskListActorConfig)

  test("TaskCreated adds a task with pending status", () => {
    const state: TaskListState = { tasks: [] }
    const result = reduce(state, mkTaskCreated("t-1", "Fix auth"))
    expect(result.state.tasks).toEqual([{ id: "t-1", subject: "Fix auth", status: "pending" }])
  })

  test("TaskUpdated changes the status", () => {
    const state: TaskListState = {
      tasks: [{ id: "t-1" as TaskId, subject: "Fix auth", status: "pending" }],
    }
    const result = reduce(state, mkTaskUpdated("t-1", "in_progress"))
    expect(result.state.tasks[0]!.status).toBe("in_progress")
  })

  test("TaskCompleted sets status to completed", () => {
    const state: TaskListState = {
      tasks: [{ id: "t-1" as TaskId, subject: "Fix auth", status: "in_progress" }],
    }
    const result = reduce(state, mkTaskCompleted("t-1"))
    expect(result.state.tasks[0]!.status).toBe("completed")
  })

  test("TaskFailed sets status to failed", () => {
    const state: TaskListState = {
      tasks: [{ id: "t-1" as TaskId, subject: "Fix auth", status: "in_progress" }],
    }
    const result = reduce(state, mkTaskFailed("t-1"))
    expect(result.state.tasks[0]!.status).toBe("failed")
  })

  test("TaskStopped sets status to stopped", () => {
    const state: TaskListState = {
      tasks: [{ id: "t-1" as TaskId, subject: "Fix auth", status: "in_progress" }],
    }
    const result = reduce(state, mkTaskStopped("t-1"))
    expect(result.state.tasks[0]!.status).toBe("stopped")
  })

  test("TaskDeleted removes the task", () => {
    const state: TaskListState = {
      tasks: [
        { id: "t-1" as TaskId, subject: "Fix auth", status: "completed" },
        { id: "t-2" as TaskId, subject: "Add tests", status: "pending" },
      ],
    }
    const result = reduce(state, mkTaskDeleted("t-1"))
    expect(result.state.tasks).toEqual([{ id: "t-2", subject: "Add tests", status: "pending" }])
  })

  test("unrelated events are no-ops (reference equality)", () => {
    const state: TaskListState = {
      tasks: [{ id: "t-1" as TaskId, subject: "Fix auth", status: "pending" }],
    }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state).toBe(state)
  })

  test("derive produces uiModel with tasks array", () => {
    const state: TaskListState = {
      tasks: [
        { id: "t-1" as TaskId, subject: "Fix auth", status: "completed" },
        { id: "t-2" as TaskId, subject: "Add tests", status: "pending" },
      ],
    }
    const projection = derive(state)
    const ui = projection.uiModel as {
      tasks: Array<{ id: string; subject: string; status: string }>
    }
    expect(ui.tasks).toEqual([
      { id: "t-1", subject: "Fix auth", status: "completed" },
      { id: "t-2", subject: "Add tests", status: "pending" },
    ])
  })
})
