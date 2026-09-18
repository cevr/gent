/**
 * `mapAcpUpdateToResponsePart` is the whole ACP→gent content path.
 *
 * It is exported `@internal` for testing and had no test: every ACP
 * notification the agent sends passes through it, so a wrong tool name,
 * a dropped thought chunk or a mis-shaped tool result is invisible
 * without these assertions.
 */
import type { Schema } from "effect"
import { Effect, Option } from "effect"
import { describe, expect, it } from "effect-bun-test"

import {
  makeAcpResponsePartMapper,
  mapAcpUpdateToResponsePart,
  SessionNotification,
} from "../../src/acp-agents.js"

/**
 * `SessionNotification.update` is deliberately `Schema.Unknown` — the ACP
 * `sessionUpdate` payload is open and the mapper is what narrows it.
 */
const notification = (update: Schema.Schema.Type<typeof Schema.Unknown>): SessionNotification =>
  new SessionNotification({ sessionId: "s1", update })

describe("acp update mapping", () => {
  it.live("turns an agent_message_chunk into a text delta", () =>
    Effect.sync(() => {
      const part = mapAcpUpdateToResponsePart(
        notification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        }),
      )
      expect(Option.isSome(part)).toBe(true)
      const value = Option.getOrThrow(part)
      expect(value.type).toBe("text-delta")
      expect(value).toMatchObject({ id: "acp-text", delta: "hi" })
    }),
  )

  it.live("turns an agent_thought_chunk into a reasoning delta", () =>
    Effect.sync(() => {
      // Thought chunks must not land in the assistant's visible text —
      // a shared part id would merge reasoning into the reply.
      const part = mapAcpUpdateToResponsePart(
        notification({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "pondering" },
        }),
      )
      const value = Option.getOrThrow(part)
      expect(value.type).toBe("reasoning-delta")
      expect(value).toMatchObject({ id: "acp-reasoning", delta: "pondering" })
    }),
  )

  it.live("drops a chunk whose content is not a text block", () =>
    Effect.sync(() => {
      const part = mapAcpUpdateToResponsePart(
        notification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "…", mimeType: "image/png" },
        }),
      )
      expect(Option.isNone(part)).toBe(true)
    }),
  )

  it.live("names a tool-call part after the notification title", () =>
    Effect.sync(() => {
      const part = mapAcpUpdateToResponsePart(
        notification({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file" }),
      )
      const value = Option.getOrThrow(part)
      expect(value.type).toBe("tool-call")
      expect(value).toMatchObject({ id: "t1", name: "read_file", providerExecuted: false })
    }),
  )

  it.live("carries the tool name from the call into its later result", () =>
    Effect.sync(() => {
      // The mapper is stateful by design: `tool_call_update` carries no
      // name, so a shared mapper is what keeps the result labelled.
      const mapper = makeAcpResponsePartMapper()
      mapAcpUpdateToResponsePart(
        notification({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file" }),
        mapper,
      )
      const result = mapAcpUpdateToResponsePart(
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "file body" } }],
        }),
        mapper,
      )
      const value = Option.getOrThrow(result)
      expect(value.type).toBe("tool-result")
      expect(value).toMatchObject({
        id: "t1",
        name: "read_file",
        result: "file body",
        isFailure: false,
      })
    }),
  )

  it.live("labels a result whose tool call was never announced", () =>
    Effect.sync(() => {
      const result = mapAcpUpdateToResponsePart(
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "orphan",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "done" } }],
        }),
      )
      expect(Option.getOrThrow(result)).toMatchObject({ name: "external", result: "done" })
    }),
  )

  it.live("marks a failed tool_call_update as a failure result", () =>
    Effect.sync(() => {
      const result = mapAcpUpdateToResponsePart(
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "t2",
          status: "failed",
          error: "permission denied",
        }),
      )
      expect(Option.getOrThrow(result)).toMatchObject({
        id: "t2",
        result: "permission denied",
        isFailure: true,
      })
    }),
  )

  it.live("emits nothing for an in-progress tool_call_update", () =>
    Effect.sync(() => {
      // Only terminal statuses produce a part; a `pending` update would
      // otherwise emit a tool-result before the tool finished.
      const result = mapAcpUpdateToResponsePart(
        notification({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "pending" }),
      )
      expect(Option.isNone(result)).toBe(true)
    }),
  )

  it.live("ignores a session update kind the adapter does not handle", () =>
    Effect.sync(() => {
      expect(
        Option.isNone(mapAcpUpdateToResponsePart(notification({ sessionUpdate: "plan" }))),
      ).toBe(true)
      expect(Option.isNone(mapAcpUpdateToResponsePart(notification("not an object")))).toBe(true)
    }),
  )
})
