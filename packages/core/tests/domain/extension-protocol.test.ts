import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  ExtensionMessage,
  getExtensionMessageMetadata,
  getExtensionReplyDecoder,
  getExtensionReplySchema,
  isExtensionRequestDefinition,
  isExtensionRequestMessage,
  type ExtractExtensionReply,
} from "@gent/core/domain/extension-protocol"

describe("extension protocol branding", () => {
  test("command builders attach hidden runtime metadata", () => {
    const TogglePlan = ExtensionMessage.command("plan", "TogglePlan", {})
    const message = TogglePlan.make()

    expect(message).toEqual({
      extensionId: "plan",
      _tag: "TogglePlan",
    })
    expect(Object.keys(message)).toEqual(["extensionId", "_tag"])

    const metadata = getExtensionMessageMetadata(message)
    expect(metadata?._tag).toBe("command")
    expect(metadata?.extensionId).toBe("plan")
    expect(metadata?.tag).toBe("TogglePlan")

    const decoded = Schema.decodeUnknownSync(TogglePlan.schema)({
      extensionId: "plan",
      _tag: "TogglePlan",
    })
    expect(decoded).toEqual(message)
    expect(getExtensionMessageMetadata(decoded)).toBeUndefined()
  })

  test("request builders brand replies and expose reply schema", () => {
    const GetTask = ExtensionMessage.reply(
      "@gent/task-tools",
      "GetTask",
      { taskId: Schema.String },
      Schema.Struct({ status: Schema.String }),
    )
    const request = GetTask.make({ taskId: "task-1" })
    const _typedReply: ExtractExtensionReply<typeof request> = { status: "ok" }
    void _typedReply

    expect(isExtensionRequestMessage(request)).toBe(true)
    expect(isExtensionRequestDefinition(GetTask)).toBe(true)
    expect(getExtensionMessageMetadata(request)?._tag).toBe("request")
    expect(getExtensionReplySchema(request)).toBe(GetTask.replySchema)
    expect(getExtensionReplyDecoder(request)).toBe(GetTask.replyDecoder)
    expect(Object.keys(request)).toEqual(["extensionId", "_tag", "taskId"])
  })

  test("reserved keys are rejected at definition time", () => {
    expect(() =>
      ExtensionMessage.command("plan", "Bad", {
        extensionId: Schema.String,
      }),
    ).toThrow("reserved keys")
  })
})
