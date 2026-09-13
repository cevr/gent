/**
 * The message a parent agent reads when a child finishes.
 *
 * A turn receipt is not task success. A child can be interrupted, have its
 * model stream fail, or spend its continuations without ever answering —
 * and in each case the text it produced looks like an ordinary (if short)
 * result. If the outcome is not named in the message, the parent model
 * reads a failure as a completed answer.
 */

import { describe, expect, test } from "bun:test"
import { describeChildCompletion } from "../../src/runtime/agent/child-completion"
import { TurnCompleted } from "../../src/domain/event"
import { AgentName } from "../../src/domain/agent"
import { BranchId, MessageId, RequestId, SessionId } from "../../src/domain/ids"

const sessionId = SessionId.make("child-session")
const branchId = BranchId.make("child-branch")
const requestId = RequestId.make("child-request")

const child = {
  sessionId,
  branchId,
  input: {
    parentSessionId: SessionId.make("parent-session"),
    parentBranchId: BranchId.make("parent-branch"),
    agentName: AgentName.make("main"),
    prompt: "do the thing",
    cwd: "/tmp",
  },
}

const completionWith = (flags: {
  readonly interrupted?: boolean
  readonly streamFailed?: boolean
  readonly unanswered?: boolean
}) =>
  TurnCompleted.make({
    sessionId,
    branchId,
    messageId: MessageId.make(`agent-start:${requestId}`),
    durationMs: 1,
    ...flags,
  })

const message = (flags: Parameters<typeof completionWith>[0], text = "the child output") =>
  describeChildCompletion({
    requestId,
    agentName: AgentName.make("main"),
    child,
    completion: completionWith(flags),
    text,
  })

describe("child completion message", () => {
  test("reports a clean turn as completed", () => {
    const rendered = message({})
    expect(rendered).toContain("completed")
    expect(rendered).not.toContain("ended (")
    expect(rendered).toContain("the child output")
  })

  test("names an unanswered turn so the parent does not read it as an answer", () => {
    // The child ran, spent both continuations, and produced nothing. Without
    // this the parent sees "completed" and an empty body.
    const rendered = message({ unanswered: true }, "")
    expect(rendered).toContain("ended (no answer produced)")
  })

  test("names an interrupted turn", () => {
    expect(message({ interrupted: true })).toContain("ended (interrupted)")
  })

  test("names a failed model stream", () => {
    expect(message({ streamFailed: true })).toContain("ended (model stream failed)")
  })

  test("names every outcome when a turn ends badly in more than one way", () => {
    const rendered = message({ interrupted: true, streamFailed: true, unanswered: true })
    expect(rendered).toContain("ended (interrupted, model stream failed, no answer produced)")
  })

  test("always warns that a receipt is not task success", () => {
    expect(message({})).toContain("Completion is a turn receipt, not task success")
  })
})
