import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import type { TaskId } from "../domain/ids.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { TaskProtocol } from "../extensions/task-tools-protocol.js"

export const TaskOutputParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to get output for" }),
})

export const TaskOutputTool = defineTool({
  name: "task_output",
  action: "state",
  concurrency: "parallel",
  idempotent: true,
  description:
    "Get the output messages from a task's child session. Returns the conversation between the agent and tools.",
  params: TaskOutputParams,
  execute: Effect.fn("TaskOutputTool.execute")(function* (params, ctx) {
    const runtime = yield* ExtensionStateRuntime
    const result = yield* runtime.ask(
      ctx.sessionId,
      TaskProtocol.GetTaskOutput({ taskId: params.taskId as TaskId }),
      ctx.branchId,
    )
    if (result == null) {
      return { error: `Task not found: ${params.taskId}` }
    }

    return {
      status: result.status,
      messageCount: result.messageCount,
      ...(result.messages !== undefined ? { messages: result.messages } : {}),
    }
  }),
})
