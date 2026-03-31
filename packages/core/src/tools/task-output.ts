import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import type { TaskId } from "../domain/ids.js"
import { TaskService } from "../runtime/task-service.js"

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
  execute: Effect.fn("TaskOutputTool.execute")(function* (params) {
    const taskService = yield* TaskService

    const result = yield* taskService.getOutput(params.taskId as TaskId)
    if (result === undefined) {
      return { error: `Task not found: ${params.taskId}` }
    }

    const messages = result.messages.map((m) => ({
      role: m.role,
      parts: m.parts.map((p) => {
        if (p.type === "text") return { type: "text" as const, text: p.text }
        if (p.type === "tool-call") return { type: "tool-call" as const, toolName: p.toolName }
        if (p.type === "tool-result")
          return { type: "tool-result" as const, toolName: p.toolName, outputType: p.output.type }
        return { type: p.type }
      }),
    }))

    return {
      status: result.status,
      messageCount: result.messages.length,
      messages,
    }
  }),
})
