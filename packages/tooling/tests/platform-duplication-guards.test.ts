import { describe, expect, test } from "bun:test"
import { findPlatformDuplicationViolations } from "../src/platform-duplication-guards"

describe("platform duplication guards", () => {
  test("ignores docs and tests", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/tests/runtime/example.test.ts",
        "const name = 'TurnEvent'",
      ),
    ).toEqual([])
  })

  test("flags deleted runtime bridge names in active source", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "const a = ExtensionRuntime",
          "const b = ExtensionTurnControl",
          "const c = TurnEvent",
          "const d = TurnEventUsage",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message: "ExtensionRuntime marker service is deleted; use explicit services",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 2,
        message: "ExtensionTurnControl mailbox is deleted; use the session runtime protocol",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 3,
        message: "TurnEvent duplicates Effect AI response parts",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 4,
        message: "TurnEvent duplicates Effect AI response parts",
      },
    ])
  })

  test("flags deleted storage subtag adapter", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        "const layer = subTagLayers(base)",
      ),
    ).toEqual([
      {
        file: "packages/core/src/storage/example.ts",
        line: 1,
        message: "Storage subtag adapter is deleted; use SqliteStorage composition roots",
      },
    ])
  })

  test("flags deleted public actor rpc path", () => {
    expect(findPlatformDuplicationViolations("packages/core/src/server/rpcs/actor.ts", "")).toEqual(
      [
        {
          file: "packages/core/src/server/rpcs/actor.ts",
          line: 1,
          message: "Public actor RPC surface is deleted; use product RPCs",
        },
      ],
    )

    expect(
      findPlatformDuplicationViolations("packages/core/src/server/rpcs/session.ts", ""),
    ).toEqual([])
  })

  test("does not flag the guard source itself", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/tooling/src/platform-duplication-guards.ts",
        ["ExtensionRuntime", "ctx.extension.request(ref)", "subTagLayers(base)"].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags session transport dto names only in the transport contract", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/transport-contract.ts",
        "export class SessionInfo {}",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/transport-contract.ts",
        line: 1,
        message: "Transport session DTOs mirror domain types",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/domain/example.ts",
        "export class SessionInfo {}",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/transport-contract.ts",
        ["export class BranchInfo {}", "const runtime = ExtensionRuntime"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/transport-contract.ts",
        line: 1,
        message: "Transport session DTOs mirror domain types",
      },
      {
        file: "packages/core/src/server/transport-contract.ts",
        line: 2,
        message: "ExtensionRuntime marker service is deleted; use explicit services",
      },
    ])
  })

  test("flags stale in-process extension rpc comments and calls", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        ["ctx.extension.request(ref)", "// typed RPC helpers"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/example.ts",
        line: 1,
        message: "In-process extension RPC is deleted; yield services or use public transport",
      },
      {
        file: "packages/extensions/src/example.ts",
        line: 2,
        message: "Host contexts no longer expose typed RPC helpers",
      },
    ])
  })
})
