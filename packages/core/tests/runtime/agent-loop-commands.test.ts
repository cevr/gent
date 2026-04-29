import { describe, expect, test } from "effect-bun-test"
import { Schema } from "effect"
import {
  AgentLoopError,
  LoopCommand,
  makeCommandId,
  toolCallIdForCommand,
  assistantMessageIdForCommand,
  toolResultMessageIdForCommand,
} from "../../src/runtime/agent/agent-loop.commands"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"

const sessionId = SessionId.make("command-session")
const branchId = BranchId.make("command-branch")

const messageInput = {
  _tag: "regular",
  id: MessageId.make("command-message"),
  sessionId,
  branchId,
  role: "user",
  parts: [{ type: "text", text: "hello" }],
  createdAt: 0,
}

describe("agent loop commands", () => {
  test("command ids derive stable message and tool ids", () => {
    const commandId = makeCommandId()

    expect(String(toolCallIdForCommand(commandId))).toBe(String(commandId))
    expect(String(assistantMessageIdForCommand(commandId))).toBe(`${commandId}:assistant`)
    expect(String(toolResultMessageIdForCommand(commandId))).toBe(`${commandId}:tool-result`)
  })

  test("loop command schema accepts submit turn commands", () => {
    const input = {
      _tag: "SubmitTurn",
      message: messageInput,
      interactive: true,
    }
    const command = Schema.decodeUnknownSync(LoopCommand)(input)
    if (command._tag !== "SubmitTurn") {
      throw new Error(`expected SubmitTurn, got ${command._tag}`)
    }

    expect(command._tag).toBe("SubmitTurn")
    expect(command.message.id).toBe(MessageId.make("command-message"))
    expect(command.interactive).toBe(true)
  })

  test("loop command schema accepts every command variant", () => {
    const commandId = makeCommandId()
    const inputs = [
      { _tag: "RunTurn", message: messageInput },
      { _tag: "ApplySteer", command: { _tag: "Cancel", sessionId, branchId } },
      { _tag: "RespondInteraction", sessionId, branchId, requestId: "request-1" },
      {
        _tag: "RecordToolResult",
        sessionId,
        branchId,
        commandId,
        toolCallId: toolCallIdForCommand(commandId),
        toolName: "probe",
        output: { ok: true },
      },
      {
        _tag: "InvokeTool",
        sessionId,
        branchId,
        commandId,
        toolName: "probe",
        input: { value: "x" },
      },
    ]

    expect(inputs.map((input) => Schema.decodeUnknownSync(LoopCommand)(input)._tag)).toEqual([
      "RunTurn",
      "ApplySteer",
      "RespondInteraction",
      "RecordToolResult",
      "InvokeTool",
    ])
  })

  test("agent loop errors decode through the extracted schema", () => {
    const error = Schema.decodeUnknownSync(AgentLoopError)({
      _tag: "AgentLoopError",
      message: "failed",
    })

    expect(error._tag).toBe("AgentLoopError")
    expect(error.message).toBe("failed")
  })
})
