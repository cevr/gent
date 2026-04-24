import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  ExtensionMessage,
  getExtensionMessageMetadata,
  getExtensionReplyDecoder,
  getExtensionReplySchema,
  isExtensionRequestDefinition,
  isExtensionRequestMessage,
  listExtensionProtocolDefinitions,
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
    expect(getExtensionMessageMetadata(GetTask)).toBeUndefined()
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

  test("command payloads cannot spoof envelope fields", () => {
    const Ping = ExtensionMessage.command("plan", "Ping", { text: Schema.String })
    const extensionIdPayload = { text: "hello", extensionId: "other-extension" }
    const tagPayload = { text: "hello", _tag: "OtherMessage" }

    expect(() => Ping.make(extensionIdPayload)).toThrow("reserved keys")
    expect(() => Ping.make(tagPayload)).toThrow("reserved keys")
  })

  test("request payloads cannot spoof envelope fields", () => {
    const GetTask = ExtensionMessage.reply(
      "@gent/task-tools",
      "GetTask",
      { taskId: Schema.String },
      Schema.Struct({ status: Schema.String }),
    )
    const extensionIdPayload = { taskId: "task-1", extensionId: "other-extension" }
    const tagPayload = { taskId: "task-1", _tag: "OtherMessage" }

    expect(() => GetTask.make(extensionIdPayload)).toThrow("reserved keys")
    expect(() => GetTask.make(tagPayload)).toThrow("reserved keys")
  })

  test("protocol registration rejects message instances", () => {
    const Ping = ExtensionMessage.command("plan", "Ping", {})

    expect(() =>
      listExtensionProtocolDefinitions({
        Ping: Ping.make(),
      }),
    ).toThrow('protocol entry "Ping" is not a message definition')
  })

  test("`.is` validates the full payload — tag-only envelope is rejected", () => {
    // A command definition's type predicate is a contract: callers narrow to
    // the full typed shape and read typed payload fields. An envelope with
    // the right tag but a malformed/missing payload would otherwise be a
    // typed lie — the handler reads `.taskId` and gets undefined.
    const GetTask = ExtensionMessage.reply(
      "@gent/task-tools",
      "GetTask",
      { taskId: Schema.String },
      Schema.Struct({ status: Schema.String }),
    )

    const validRequest = GetTask.make({ taskId: "task-1" })
    expect(GetTask.is(validRequest)).toBe(true)

    // Envelope tag matches but payload is missing the required field.
    const envelopeOnly = { extensionId: "@gent/task-tools", _tag: "GetTask" }
    expect(GetTask.is(envelopeOnly)).toBe(false)
    // Escape hatch: envelope-level predicate for cheap routing.
    expect(GetTask.hasEnvelopeTag(envelopeOnly)).toBe(true)

    // Wrong payload shape — numeric where string is required.
    const badPayload = {
      extensionId: "@gent/task-tools",
      _tag: "GetTask",
      taskId: 42,
    }
    expect(GetTask.is(badPayload)).toBe(false)
    expect(GetTask.hasEnvelopeTag(badPayload)).toBe(true)

    // Wrong extensionId even with a valid-looking payload.
    const wrongExtension = {
      extensionId: "@gent/other",
      _tag: "GetTask",
      taskId: "task-1",
    }
    expect(GetTask.is(wrongExtension)).toBe(false)
    expect(GetTask.hasEnvelopeTag(wrongExtension)).toBe(false)
  })
})
