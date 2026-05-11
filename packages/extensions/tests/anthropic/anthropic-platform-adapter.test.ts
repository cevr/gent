/**
 * AnthropicPlatform.fromSetup invariant lock.
 *
 * `platform.home` must source from `host.homeDirectory` (the OS user home),
 * NOT `ctx.home` (the Gent-configured home). The Claude Code credential
 * file is read from `~/.config/claude/.credentials.json` at the real OS
 * home regardless of any `GENT_HOME` override.
 *
 * This is a regression lock: an earlier refactor in W33-C4 briefly used
 * `ctx.home`, which would have redirected credential lookup to the
 * configured Gent home and broken Anthropic OAuth for any setup with a
 * non-default `GENT_HOME`.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AnthropicPlatform } from "../../src/anthropic/platform-adapter.js"
import { ExtensionHostProcessError } from "@gent/core-internal/domain/extension"
import type { PublicExtensionSetupContext } from "@gent/core/extensions/api"

const makeCtxWithSplitHome = (gentHome: string, osHome: string): PublicExtensionSetupContext => ({
  cwd: "/tmp",
  source: "test",
  home: gentHome,
  host: {
    osInfo: {
      platform: "darwin",
      arch: "arm64",
      release: "test",
      hostname: "test-host",
      type: "Darwin",
    },
    execPath: "/usr/bin/node",
    homeDirectory: osHome,
    pathListSeparator: ":",
  },
  Process: {
    parentEnv: {},
    runProcess: (command) =>
      Effect.fail(
        new ExtensionHostProcessError({
          command,
          message: "test runProcess unavailable",
        }),
      ),
    signalPid: () => Effect.void,
    isPortFree: () => Effect.succeed(true),
    isPidAlive: () => Effect.succeed(true),
    commandCandidates: (command) => [command],
  },
})

describe("AnthropicPlatform.fromSetup", () => {
  test("sources home from host.homeDirectory, not ctx.home", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {})
    expect(platform.home).toBe("/Users/test-os-home")
  })

  test("forwards platform from host.osInfo", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {})
    expect(platform.platform).toBe("darwin")
  })

  test("forwards parentEnv and runProcess from Process", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {})
    expect(platform.parentEnv).toEqual({})
    expect(typeof platform.runProcess).toBe("function")
  })

  test("carries per-instance env snapshot", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {
      betaFlags: "context-1m-2025-08-07",
      cliVersion: "1.2.3",
      entrypoint: "tui",
      userAgent: "custom/1.0",
    })
    expect(platform.env.betaFlags).toBe("context-1m-2025-08-07")
    expect(platform.env.cliVersion).toBe("1.2.3")
    expect(platform.env.entrypoint).toBe("tui")
    expect(platform.env.userAgent).toBe("custom/1.0")
  })

  test("two fromSetup calls produce independent env snapshots", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const a = AnthropicPlatform.fromSetup(ctx, { betaFlags: "flag-a" })
    const b = AnthropicPlatform.fromSetup(ctx, { betaFlags: "flag-b" })
    expect(a.env.betaFlags).toBe("flag-a")
    expect(b.env.betaFlags).toBe("flag-b")
  })
})
