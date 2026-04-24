import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { buildExtensionHealthSnapshot } from "../../src/server/extension-health"
import {
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
} from "@gent/core/server/transport-contract"

describe("buildExtensionHealthSnapshot", () => {
  test("merges activation, actor, and scheduler failures into typed issue rows", () => {
    const snapshot = buildExtensionHealthSnapshot(
      [
        {
          manifest: { id: "@gent/memory" },
          scope: "builtin",
          sourcePath: "builtin",
          status: "failed",
          phase: "startup",
          error: "startup boom",
        },
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin",
          sourcePath: "builtin",
          status: "active",
          scheduledJobFailures: [{ jobId: "reflect", error: "launchd boom" }],
        },
      ],
      [
        {
          _tag: "failed",
          extensionId: "@gent/plan",
          sessionId: "s1" as never,
          branchId: "b1" as never,
          error: "actor boom",
          failurePhase: "runtime",
        },
      ],
    )

    expect(snapshot._tag).toBe("degraded")
    if (snapshot._tag !== "degraded") return

    expect(snapshot.healthyExtensions).toEqual([])
    expect(snapshot.degradedExtensions).toEqual([
      {
        manifest: { id: "@gent/memory" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "degraded",
        issues: [
          {
            _tag: "activation-failed",
            phase: "startup",
            error: "startup boom",
          },
        ],
      },
      {
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "degraded",
        issues: [
          {
            _tag: "actor-failed",
            sessionId: "s1",
            branchId: "b1",
            error: "actor boom",
            failurePhase: "runtime",
          },
          {
            _tag: "scheduled-job-failed",
            jobId: "reflect",
            error: "launchd boom",
          },
        ],
      },
    ])
  })

  test("returns a healthy snapshot when every extension has no issues", () => {
    const snapshot = buildExtensionHealthSnapshot([
      {
        manifest: { id: "@gent/memory" },
        scope: "builtin",
        sourcePath: "builtin",
        status: "active",
      },
    ])

    expect(snapshot).toEqual({
      _tag: "healthy",
      extensions: [
        {
          _tag: "healthy",
          manifest: { id: "@gent/memory" },
          scope: "builtin",
          sourcePath: "builtin",
        },
      ],
    })
  })

  test("health issue constructors preserve typed failure categories", () => {
    expect(
      ExtensionHealthIssue.ActivationFailed.make({
        phase: "startup",
        error: "startup boom",
      }),
    ).toEqual({
      _tag: "activation-failed",
      phase: "startup",
      error: "startup boom",
    })
    expect(
      ExtensionHealthIssue.ScheduledJobFailed.make({
        jobId: "reflect",
        error: "launchd boom",
      }),
    ).toEqual({
      _tag: "scheduled-job-failed",
      jobId: "reflect",
      error: "launchd boom",
    })
  })

  test("degraded constructor requires non-empty issues", () => {
    expect(
      ExtensionHealth.Degraded.make({
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        issues: [
          ExtensionHealthIssue.ActorFailed.make({
            sessionId: "s1" as never,
            error: "actor boom",
            failurePhase: "runtime",
          }),
        ],
      }),
    ).toEqual({
      _tag: "degraded",
      manifest: { id: "@gent/plan" },
      scope: "builtin",
      sourcePath: "builtin",
      issues: [
        {
          _tag: "actor-failed",
          sessionId: "s1",
          error: "actor boom",
          failurePhase: "runtime",
        },
      ],
    })
  })

  test("transport uses tagged extension health states and issues", () => {
    const wire = {
      _tag: "degraded",
      healthyExtensions: [],
      degradedExtensions: [
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin",
          sourcePath: "builtin",
          _tag: "degraded",
          issues: [
            {
              _tag: "actor-failed",
              sessionId: "s1",
              branchId: "b1",
              error: "actor boom",
              failurePhase: "runtime",
            },
          ],
        },
      ],
    }

    const decoded = Schema.decodeUnknownSync(ExtensionHealthSnapshot)(wire)
    expect(decoded._tag).toBe("degraded")
    if (decoded._tag !== "degraded") return
    expect(decoded.degradedExtensions[0]?.issues[0]).toEqual({
      _tag: "actor-failed",
      sessionId: "s1",
      branchId: "b1",
      error: "actor boom",
      failurePhase: "runtime",
    })

    const encoded = Schema.encodeSync(ExtensionHealthSnapshot)(decoded)
    expect(encoded).toMatchObject({
      _tag: "degraded",
      degradedExtensions: [
        {
          _tag: "degraded",
          issues: [
            {
              _tag: "actor-failed",
              sessionId: "s1",
              branchId: "b1",
              error: "actor boom",
              failurePhase: "runtime",
            },
          ],
        },
      ],
    })
  })

  test("transport rejects healthy snapshots containing degraded rows", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "healthy",
        extensions: [
          {
            manifest: { id: "@gent/memory" },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "degraded",
            issues: [{ _tag: "activation-failed", phase: "startup", error: "startup boom" }],
          },
        ],
      }),
    ).toThrow()
  })

  test("transport rejects degraded snapshots without degraded rows", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "degraded",
        healthyExtensions: [],
        degradedExtensions: [],
      }),
    ).toThrow()
  })

  test("transport rejects degraded rows without issues", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "degraded",
        healthyExtensions: [],
        degradedExtensions: [
          {
            manifest: { id: "@gent/memory" },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "degraded",
            issues: [],
          },
        ],
      }),
    ).toThrow()
  })
})
