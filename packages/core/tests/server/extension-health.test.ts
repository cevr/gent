import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { buildExtensionHealthSnapshot } from "../../src/server/extension-health"
import {
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
} from "../../src/server/transport-contract"
import { ExtensionId } from "../../src/domain/ids"

describe("buildExtensionHealthSnapshot", () => {
  test("reports one typed issue row per failed extension", () => {
    const snapshot = buildExtensionHealthSnapshot([
      {
        manifest: { id: ExtensionId.make("@gent/memory") },
        scope: "builtin",
        sourcePath: "builtin",
        status: "failed",
        phase: "startup",
        error: "startup boom",
      },
      {
        manifest: { id: ExtensionId.make("@gent/plan") },
        scope: "builtin",
        sourcePath: "builtin",
        status: "failed",
        phase: "setup",
        error: "setup boom",
      },
    ])

    expect(snapshot._tag).toBe("Degraded")
    if (snapshot._tag !== "Degraded") return

    expect(snapshot.healthyExtensions).toEqual([])
    expect(snapshot.degradedExtensions).toEqual([
      {
        manifest: { id: "@gent/memory" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "Degraded",
        issues: [
          {
            _tag: "ActivationFailed",
            phase: "startup",
            error: "startup boom",
          },
        ],
      },
      {
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "Degraded",
        issues: [
          {
            _tag: "ActivationFailed",
            phase: "setup",
            error: "setup boom",
          },
        ],
      },
    ])
  })

  test("returns a healthy snapshot when every extension has no issues", () => {
    const snapshot = buildExtensionHealthSnapshot([
      {
        manifest: { id: ExtensionId.make("@gent/memory") },
        scope: "builtin",
        sourcePath: "builtin",
        status: "active",
      },
    ])

    expect(snapshot).toEqual({
      _tag: "Healthy",
      extensions: [
        {
          _tag: "Healthy",
          manifest: { id: ExtensionId.make("@gent/memory") },
          scope: "builtin",
          sourcePath: "builtin",
        },
      ],
    })
  })

  test("health issue constructors preserve typed failure categories", () => {
    expect(
      ExtensionHealthIssue.cases.ActivationFailed.make({
        phase: "startup",
        error: "startup boom",
      }),
    ).toEqual({
      _tag: "ActivationFailed",
      phase: "startup",
      error: "startup boom",
    })
  })

  test("degraded constructor requires non-empty issues", () => {
    expect(
      ExtensionHealth.cases.Degraded.make({
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        issues: [
          ExtensionHealthIssue.cases.ActivationFailed.make({
            phase: "startup",
            error: "launchd boom",
          }),
        ],
      }),
    ).toEqual({
      _tag: "Degraded",
      manifest: { id: "@gent/plan" },
      scope: "builtin",
      sourcePath: "builtin",
      issues: [
        {
          _tag: "ActivationFailed",
          phase: "startup",
          error: "launchd boom",
        },
      ],
    })
  })

  test("transport uses tagged extension health states and issues", () => {
    const wire = {
      _tag: "Degraded",
      healthyExtensions: [],
      degradedExtensions: [
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin",
          sourcePath: "builtin",
          _tag: "Degraded",
          issues: [
            {
              _tag: "ActivationFailed",
              phase: "startup",
              error: "launchd boom",
            },
          ],
        },
      ],
    }

    const decoded = Schema.decodeUnknownSync(ExtensionHealthSnapshot)(wire)
    expect(decoded._tag).toBe("Degraded")
    if (decoded._tag !== "Degraded") return
    expect(decoded.degradedExtensions[0]?.issues[0]).toEqual({
      _tag: "ActivationFailed",
      phase: "startup",
      error: "launchd boom",
    })

    const encoded = Schema.encodeSync(ExtensionHealthSnapshot)(decoded)
    expect(encoded).toMatchObject({
      _tag: "Degraded",
      degradedExtensions: [
        {
          _tag: "Degraded",
          issues: [
            {
              _tag: "ActivationFailed",
              phase: "startup",
              error: "launchd boom",
            },
          ],
        },
      ],
    })
  })

  test("transport rejects healthy snapshots containing degraded rows", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "Healthy",
        extensions: [
          {
            manifest: { id: ExtensionId.make("@gent/memory") },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "Degraded",
            issues: [{ _tag: "ActivationFailed", phase: "startup", error: "startup boom" }],
          },
        ],
      }),
    ).toThrow()
  })

  test("transport rejects degraded snapshots without degraded rows", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "Degraded",
        healthyExtensions: [],
        degradedExtensions: [],
      }),
    ).toThrow()
  })

  test("transport rejects degraded rows without issues", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        _tag: "Degraded",
        healthyExtensions: [],
        degradedExtensions: [
          {
            manifest: { id: ExtensionId.make("@gent/memory") },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "Degraded",
            issues: [],
          },
        ],
      }),
    ).toThrow()
  })
})
