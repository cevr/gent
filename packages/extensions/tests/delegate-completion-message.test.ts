import { describe, expect, test } from "bun:test"
import { describeChildCompletion } from "../src/delegate.js"
import { AgentName, BranchId, SessionId } from "@gent/core/protocol"
import { RequestId } from "@gent/core/extensions/api"

// ── delegate/completion-message ─────────────────────────────────────────────

/**
 * The message a parent agent reads when a child finishes.
 *
 * A turn receipt is not task success. A child can be interrupted, have its
 * model stream fail, or spend its continuations without ever answering — and
 * in each case the text it produced looks like an ordinary (if short) result.
 * If the outcome is not named in the message, the parent model reads a failure
 * as a completed answer.
 */

const message = (
  outcome: {
    readonly interrupted?: boolean
    readonly streamFailed?: boolean
    readonly unanswered?: boolean
  },
  text = "the child output",
) =>
  describeChildCompletion({
    requestId: RequestId.make("child-request"),
    agentName: AgentName.make("main"),
    sessionId: SessionId.make("child-session"),
    branchId: BranchId.make("child-branch"),
    outcome,
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
    expect(message({ unanswered: true }, "")).toContain("ended (no answer produced)")
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
