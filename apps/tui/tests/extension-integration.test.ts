/**
 * Integration tests for the TUI extension system.
 *
 * Tests the full pipeline: discovery → import → resolve, including
 * real file loading from temporary directories.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { loadTuiExtensions as _loadTuiExtensions } from "../src/extensions/loader-boundary"
import {
  makeClientWorkspaceLayer,
  makeClientShellLayer,
  makeClientComposerLayer,
  makeClientLifecycleLayer,
} from "../src/extensions/client-services"
import { makeClientTransportLayer } from "../src/extensions/client-transport"
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"
import {
  autocompleteContribution,
  borderLabelContribution,
  clientCommandContribution,
  composerSurfaceContribution,
  interactionRendererContribution,
} from "../src/extensions/client-facets.js"

// B11.6a: loadTuiExtensions now takes a single opts arg (no makeCtx second arg).
// This shim makes `runtime` optional in tests, defaulting to _testRuntime.
//
// Transport stub: pure load tests must not invoke any RPC. Build a Proxy
// that throws on any method access so an accidental call fails with
// "unexpected transport call in pure load test", not an opaque TypeError.
const throwOnAccess = (label: string): never => {
  throw new Error(`unexpected transport call in pure load test: ${label}`)
}
const stubClient = new Proxy(
  {},
  {
    get: (_t, prop) =>
      new Proxy(
        {},
        { get: (_t2, method) => () => throwOnAccess(`client.${String(prop)}.${String(method)}`) },
      ),
  },
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
) as Parameters<typeof makeClientTransportLayer>[0]["client"]
const stubRuntime = new Proxy(
  {},
  { get: (_t, method) => () => throwOnAccess(`runtime.${String(method)}`) },
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
) as Parameters<typeof makeClientTransportLayer>[0]["runtime"]
const _testRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    BunFileSystem.layer,
    BunServices.layer,
    makeClientWorkspaceLayer({ cwd: "/tmp/test-cwd", home: "/tmp/test-home" }),
    makeClientShellLayer({
      send: () => {},
      sendMessage: () => {},
      openOverlay: () => {},
      closeOverlay: () => {},
    }),
    makeClientComposerLayer({
      state: () => ({
        draft: "",
        mode: "editing" as const,
        inputFocused: false,
        autocompleteOpen: false,
      }),
    }),
    // B11.6: builtin widgets that migrated off the paired-package
    // snapshot cache (auto, artifacts, tasks) yield `ClientTransport`
    // from setup. The throwing Proxy stubs above guarantee any
    // accidental RPC in pure load tests surfaces with a useful message.
    makeClientTransportLayer({
      client: stubClient,
      runtime: stubRuntime,
      currentSession: () => undefined,
      onExtensionStateChanged: () => () => {},
    }),
    // ClientLifecycle: pure load tests don't unmount, so cleanups
    // accumulate harmlessly. Real disposal is exercised by integration
    // tests that mount/unmount the provider.
    makeClientLifecycleLayer({ addCleanup: () => {} }),
  ),
)
const loadTuiExtensions = (
  opts: Omit<Parameters<typeof _loadTuiExtensions>[0], "runtime"> & {
    runtime?: Parameters<typeof _loadTuiExtensions>[0]["runtime"]
  },
): ReturnType<typeof _loadTuiExtensions> =>
  _loadTuiExtensions({ ...opts, runtime: opts.runtime ?? _testRuntime })
import { SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"

const TEST_DIR = join(import.meta.dir, ".tmp-ext-integration")
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")
// Use the same barrel as production context.tsx
import { builtinClientModules } from "../src/extensions/builtins/index"

beforeAll(() => {
  mkdirSync(USER_DIR, { recursive: true })
  mkdirSync(PROJECT_DIR, { recursive: true })

  // User extension: custom tool renderer + widget + command + overlay
  // (Server side ext is skipped by TUI discovery — it returns server-shape, not client-shape)
  mkdirSync(join(USER_DIR, "custom-read"), { recursive: true })
  writeFileSync(
    join(USER_DIR, "custom-read", "index.ts"),
    `// server-side extension (should be skipped by TUI discovery)
export default { manifest: { id: "custom-read" }, setup: () => [] }`,
  )
  writeFileSync(
    join(USER_DIR, "custom-read", "client.ts"),
    `import { Effect } from "effect"
export default {
  id: "@test/custom-read",
  setup: Effect.succeed([
    { _tag: "renderer", toolNames: ["my_custom_tool"], component: () => "custom-tool-renderer" },
    { _tag: "widget", id: "test-widget", slot: "below-messages", priority: 50, component: () => "test-widget" },
    { _tag: "command", id: "test-cmd", title: "Test Command", category: "test", onSelect: () => {} },
    { _tag: "overlay", id: "test-overlay", component: () => "test-overlay" },
  ]),
}`,
  )

  // Project extension: overrides a builtin tool renderer
  writeFileSync(
    join(PROJECT_DIR, "override-bash.client.ts"),
    `import { Effect } from "effect"
export default {
  id: "@test/override-bash",
  setup: Effect.succeed([
    { _tag: "renderer", toolNames: ["bash"], component: () => "project-bash-override" },
  ]),
}`,
  )

  // Discovery fixtures that should or should not survive the public seam
  writeFileSync(
    join(USER_DIR, "alpha.client.ts"),
    "import { Effect } from 'effect'; export default { id: '@test/alpha', setup: Effect.succeed([{ _tag: 'command', id: 'alpha', title: 'Alpha', onSelect: () => {} }]) }",
  )
  writeFileSync(
    join(USER_DIR, "zeta.client.ts"),
    "import { Effect } from 'effect'; export default { id: '@test/zeta', setup: Effect.succeed([{ _tag: 'command', id: 'zeta', title: 'Zeta', onSelect: () => {} }]) }",
  )
  writeFileSync(
    join(USER_DIR, ".hidden.client.tsx"),
    "import { Effect } from 'effect'; export default { id: '@test/hidden', setup: Effect.succeed([{ _tag: 'command', id: 'hidden', title: 'Hidden', onSelect: () => {} }]) }",
  )
  writeFileSync(
    join(USER_DIR, "_internal.client.tsx"),
    "import { Effect } from 'effect'; export default { id: '@test/internal', setup: Effect.succeed([{ _tag: 'command', id: 'internal', title: 'Internal', onSelect: () => {} }]) }",
  )
  mkdirSync(join(USER_DIR, "__tests__"), { recursive: true })
  writeFileSync(
    join(USER_DIR, "__tests__", "test.client.tsx"),
    "import { Effect } from 'effect'; export default { id: '@test/spec-only', setup: Effect.succeed([{ _tag: 'command', id: 'spec-only', title: 'Spec Only', onSelect: () => {} }]) }",
  )
  writeFileSync(
    join(PROJECT_DIR, "prebuilt.client.mjs"),
    "import { Effect } from 'effect'; export default { id: '@test/prebuilt', setup: Effect.succeed([{ _tag: 'command', id: 'prebuilt', title: 'Prebuilt', onSelect: () => {} }]) }",
  )

  // Extension that uses a local openOverlay stub in a command (ctx no longer passed to setup)
  const ctxDir = join(TEST_DIR, "ctx-ext")
  mkdirSync(ctxDir, { recursive: true })
  writeFileSync(
    join(ctxDir, "ctx-user.client.ts"),
    `import { Effect } from "effect"
const ctx = { openOverlay: (_id) => {} }
export default {
  id: "@test/ctx-user",
  setup: Effect.succeed([
    { _tag: "command", id: "ctx-cmd", title: "Ctx Command", category: "test", onSelect: () => ctx.openOverlay("ctx-overlay") },
    { _tag: "overlay", id: "ctx-overlay", component: () => "ctx-overlay-component" },
  ]),
}`,
  )
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe("loadTuiExtensions integration", () => {
  test("loads builtins when no user/project extensions exist", async () => {
    const emptyUser = join(TEST_DIR, "empty-user")
    const emptyProject = join(TEST_DIR, "empty-project")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: emptyUser,
      projectDir: emptyProject,
    })

    // All builtin renderers should be present
    expect(resolved.renderers.has("read")).toBe(true)
    expect(resolved.renderers.has("edit")).toBe(true)
    expect(resolved.renderers.has("bash")).toBe(true)
    expect(resolved.renderers.has("write")).toBe(true)
    expect(resolved.renderers.has("grep")).toBe(true)
    expect(resolved.renderers.has("glob")).toBe(true)
    expect(resolved.renderers.has("webfetch")).toBe(true)
    expect(resolved.renderers.has("delegate")).toBe(true)
    expect(resolved.renderers.has("review")).toBe(true)
    expect(resolved.renderers.has("counsel")).toBe(true)
    expect(resolved.renderers.has("research")).toBe(true)
    expect(resolved.renderers.has("search_sessions")).toBe(true)
    expect(resolved.renderers.has("read_session")).toBe(true)

    rmSync(emptyUser, { recursive: true, force: true })
    rmSync(emptyProject, { recursive: true, force: true })
  })

  test("loads user extension with tool renderer", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: USER_DIR,
      projectDir: join(TEST_DIR, "no-project"),
    })

    expect(resolved.renderers.has("my_custom_tool")).toBe(true)
  })

  test("loads user extension with widget", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: USER_DIR,
      projectDir: join(TEST_DIR, "no-project"),
    })

    const widget = resolved.widgets.find((w) => w.id === "test-widget")
    expect(widget).toBeDefined()
    expect(widget?.slot).toBe("below-messages")
    expect(widget?.priority).toBe(50)
  })

  test("loads user extension with command", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: USER_DIR,
      projectDir: join(TEST_DIR, "no-project"),
    })

    const cmd = resolved.commands.find((c) => c.id === "test-cmd")
    expect(cmd).toBeDefined()
    expect(cmd?.title).toBe("Test Command")
    expect(cmd?.category).toBe("test")
  })

  test("loads user extension with overlay", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: USER_DIR,
      projectDir: join(TEST_DIR, "no-project"),
    })

    expect(resolved.overlays.has("test-overlay")).toBe(true)
  })

  test("discovery filters hidden and test-only files while still loading prebuilt mjs files", async () => {
    const resolved = await loadTuiExtensions({
      builtins: [],
      userDir: USER_DIR,
      projectDir: PROJECT_DIR,
    })

    const commandIds = resolved.commands.map((command) => command.id)
    expect(commandIds).toContain("prebuilt")
    expect(commandIds).not.toContain("hidden")
    expect(commandIds).not.toContain("internal")
    expect(commandIds).not.toContain("spec-only")
  })

  test("user-scope discovery is deterministic within scope", async () => {
    const resolved = await loadTuiExtensions({
      builtins: [],
      userDir: USER_DIR,
      projectDir: join(TEST_DIR, "no-project"),
    })

    const userCommandIds = resolved.commands
      .map((command) => command.id)
      .filter((id) => id === "alpha" || id === "zeta")
    expect(userCommandIds).toEqual(["alpha", "zeta"])
  })

  test("project extension overrides builtin tool renderer", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: join(TEST_DIR, "no-user"),
      projectDir: PROJECT_DIR,
    })

    // bash should be overridden by project extension — call it to verify
    const bashRenderer = resolved.renderers.get("bash")
    expect(bashRenderer).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((bashRenderer as any)()).toBe("project-bash-override")
  })

  test("project extension overrides user extension for same tool", async () => {
    // Create a user extension that also registers "bash"
    const userBashDir = join(TEST_DIR, "user-bash")
    mkdirSync(userBashDir, { recursive: true })
    writeFileSync(
      join(userBashDir, "override.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/user-bash",
  setup: Effect.succeed([
    { _tag: "renderer", toolNames: ["bash"], component: () => "user-bash-override" },
  ]),
}`,
    )

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: userBashDir,
      projectDir: PROJECT_DIR,
    })

    // Project should win over user — call the renderer to prove it
    const bashRenderer = resolved.renderers.get("bash")
    expect(bashRenderer).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((bashRenderer as any)()).toBe("project-bash-override")

    rmSync(userBashDir, { recursive: true, force: true })
  })

  test("extension command and overlay are loaded from setup", async () => {
    const ctxDir = join(TEST_DIR, "ctx-ext")

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: ctxDir,
      projectDir: join(TEST_DIR, "no-project"),
    })

    // The command should be registered
    const cmd = resolved.commands.find((c) => c.id === "ctx-cmd")
    expect(cmd).toBeDefined()

    // The overlay should also be registered
    expect(resolved.overlays.has("ctx-overlay")).toBe(true)
  })

  test("client extension can import a shared protocol module and send a branded message", async () => {
    const protocolDir = join(TEST_DIR, "protocol-ext")
    mkdirSync(protocolDir, { recursive: true })
    writeFileSync(
      join(protocolDir, "shared-protocol.ts"),
      `import { ExtensionMessage } from "@gent/core/domain/extension-protocol.js"
import { Schema } from "effect"

export const SharedProtocol = {
  Ping: ExtensionMessage("@test/shared", "Ping", {
    value: Schema.String,
  }),
}`,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent: unknown[] = []
    ;(globalThis as any).__testProtocolSent = sent
    writeFileSync(
      join(protocolDir, "protocol.client.ts"),
      `import { Effect } from "effect"
import { SharedProtocol } from "./shared-protocol"

export default {
  id: "@test/shared-client",
  setup: Effect.succeed([
    {
      _tag: "command",
      id: "shared.ping",
      title: "Shared Ping",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onSelect: () => { (globalThis as any).__testProtocolSent.push(SharedProtocol.Ping({ value: "pong" })) },
    },
  ]),
}`,
    )

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: protocolDir,
      projectDir: join(TEST_DIR, "no-project"),
    })

    const command = resolved.commands.find((entry) => entry.id === "shared.ping")
    expect(command).toBeDefined()
    command!.onSelect()
    expect(sent).toEqual([{ extensionId: "@test/shared", _tag: "Ping", value: "pong" }])

    rmSync(protocolDir, { recursive: true, force: true })
  })

  test("nonexistent directories are handled gracefully", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: "/nonexistent/a",
      projectDir: "/nonexistent/b",
    })

    // Should still have builtins
    expect(resolved.renderers.has("read")).toBe(true)
    expect(resolved.renderers.has("bash")).toBe(true)
  })

  test("invalid extension files are skipped gracefully", async () => {
    const badDir = join(TEST_DIR, "bad-ext")
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, "bad.client.ts"), "export default { not: 'an extension' }")

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: badDir,
      projectDir: join(TEST_DIR, "no-project"),
    })

    // Should still work — bad extension skipped, builtins present
    expect(resolved.renderers.has("read")).toBe(true)

    rmSync(badDir, { recursive: true, force: true })
  })
})

describe("session UI state — extension overlay", () => {
  test("OpenExtensionOverlay sets overlay state", () => {
    const initial = SessionUiState.initial()
    const result = transitionSessionUi(initial, {
      _tag: "OpenExtensionOverlay",
      overlayId: "my-ext:panel",
    })

    expect(result.state.overlay).toEqual({ _tag: "extension", overlayId: "my-ext:panel" })
    expect(result.effects).toEqual([])
  })

  test("CloseOverlay clears extension overlay", () => {
    const withOverlay = transitionSessionUi(SessionUiState.initial(), {
      _tag: "OpenExtensionOverlay",
      overlayId: "my-ext:panel",
    })

    const closed = transitionSessionUi(withOverlay.state, { _tag: "CloseOverlay" })
    expect(closed.state.overlay).toEqual({ _tag: "none" })
  })

  test("extension overlay replaces other overlays", () => {
    const withMermaid = transitionSessionUi(SessionUiState.initial(), { _tag: "OpenMermaid" })
    expect(withMermaid.state.overlay._tag).toBe("mermaid")

    const withExtension = transitionSessionUi(withMermaid.state, {
      _tag: "OpenExtensionOverlay",
      overlayId: "test",
    })
    expect(withExtension.state.overlay._tag).toBe("extension")
  })
})

describe("disabled extensions", () => {
  test("disabled builtin is excluded from resolved output", async () => {
    const emptyUser = join(TEST_DIR, "disabled-empty-user")
    const emptyProject = join(TEST_DIR, "disabled-empty-project")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: emptyUser,
      projectDir: emptyProject,
      disabled: ["@gent/tools"],
    })

    // Tool renderers from @gent/tools should be gone
    expect(resolved.renderers.has("read")).toBe(false)
    expect(resolved.renderers.has("bash")).toBe(false)

    // Other builtins should still be present — check that some non-disabled module loaded
    const commandIds = resolved.commands.map((c) => c.id)
    expect(commandIds).toContain("plan.create")

    rmSync(emptyUser, { recursive: true, force: true })
    rmSync(emptyProject, { recursive: true, force: true })
  })

  test("disabled user extension is not loaded or setup() called", async () => {
    const disabledDir = join(TEST_DIR, "disabled-user")
    mkdirSync(disabledDir, { recursive: true })
    // Extension that would throw in setup() if called
    writeFileSync(
      join(disabledDir, "bomb.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/bomb",
  setup: Effect.sync(() => { throw new Error("setup() should not be called for disabled extension") }),
}`,
    )

    // Should not throw — setup() should never be called
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: disabledDir,
      projectDir: join(TEST_DIR, "no-project"),
      disabled: ["@test/bomb"],
    })

    // Builtins still present
    expect(resolved.renderers.has("read")).toBe(true)

    rmSync(disabledDir, { recursive: true, force: true })
  })

  test("multiple builtins can be disabled independently", async () => {
    const emptyUser = join(TEST_DIR, "disabled-multi-user")
    const emptyProject = join(TEST_DIR, "disabled-multi-project")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: emptyUser,
      projectDir: emptyProject,
      disabled: ["@gent/plan", "@gent/task-tools"],
    })

    const widgetIds = resolved.widgets.map((w) => w.id)
    expect(widgetIds).not.toContain("plan")
    expect(widgetIds).not.toContain("tasks")
    // Connection widget should still be there
    expect(widgetIds).toContain("connection")
    // Tool renderers should still be there
    expect(resolved.renderers.has("read")).toBe(true)

    rmSync(emptyUser, { recursive: true, force: true })
    rmSync(emptyProject, { recursive: true, force: true })
  })
})

describe("same-scope collision detection", () => {
  test("two user extensions with same tool name throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-tool")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/a",
  setup: Effect.succeed([{ _tag: "renderer", toolNames: ["my_tool"], component: () => "a" }]),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/b",
  setup: Effect.succeed([{ _tag: "renderer", toolNames: ["my_tool"], component: () => "b" }]),
}`,
    )

    await expect(
      loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: collisionDir,
        projectDir: join(TEST_DIR, "no-project"),
      }),
    ).rejects.toThrow("Same-scope TUI renderer collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same widget id throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-widget")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/a",
  setup: Effect.succeed([{ _tag: "widget", id: "dup-widget", slot: "below-messages", component: () => "a" }]),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/b",
  setup: Effect.succeed([{ _tag: "widget", id: "dup-widget", slot: "above-input", component: () => "b" }]),
}`,
    )

    await expect(
      loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: collisionDir,
        projectDir: join(TEST_DIR, "no-project"),
      }),
    ).rejects.toThrow("Same-scope TUI widget collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same command id throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-cmd")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/a",
  setup: Effect.succeed([{ _tag: "command", id: "dup-cmd", title: "A", onSelect: () => {} }]),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/b",
  setup: Effect.succeed([{ _tag: "command", id: "dup-cmd", title: "B", onSelect: () => {} }]),
}`,
    )

    await expect(
      loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: collisionDir,
        projectDir: join(TEST_DIR, "no-project"),
      }),
    ).rejects.toThrow("Same-scope TUI command collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same keybind throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-kb")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/a",
  setup: Effect.succeed([{ _tag: "command", id: "cmd-a", title: "A", keybind: "ctrl+k", onSelect: () => {} }]),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/b",
  setup: Effect.succeed([{ _tag: "command", id: "cmd-b", title: "B", keybind: "ctrl+k", onSelect: () => {} }]),
}`,
    )

    await expect(
      loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: collisionDir,
        projectDir: join(TEST_DIR, "no-project"),
      }),
    ).rejects.toThrow("Same-scope TUI keybind collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same overlay id throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-overlay")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/a",
  setup: Effect.succeed([{ _tag: "overlay", id: "dup-overlay", component: () => "a" }]),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/b",
  setup: Effect.succeed([{ _tag: "overlay", id: "dup-overlay", component: () => "b" }]),
}`,
    )

    await expect(
      loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: collisionDir,
        projectDir: join(TEST_DIR, "no-project"),
      }),
    ).rejects.toThrow("Same-scope TUI overlay collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })
})

// B11.6a counsel: snapshot-ordering tests deleted along with the
// `applyExtensionSnapshot` stub. Per-cwd EventPublisher (B11.6c) covers
// the real pulse-routing concern; widget-level stale-data gating is
// exercised by the keyed `(sessionId, branchId)` state in each builtin.

describe("border label resolution", () => {
  test("resolves bottom-left and bottom-right border labels", () => {
    const extensions: LoadedTuiExtension[] = [
      {
        id: "@test/bottom-labels",
        kind: "user",
        filePath: "test:bottom-labels",
        contributions: [
          borderLabelContribution({
            position: "bottom-left",
            priority: 10,
            produce: () => [{ text: "tasks: 2", color: "info" }],
          }),
          borderLabelContribution({
            position: "bottom-right",
            priority: 20,
            produce: () => [{ text: "v1.0", color: "textMuted" }],
          }),
        ],
      },
    ]

    const resolved = resolveTuiExtensions(extensions)
    const bottomLeft = resolved.borderLabels.filter((l) => l.position === "bottom-left")
    const bottomRight = resolved.borderLabels.filter((l) => l.position === "bottom-right")

    expect(bottomLeft.length).toBe(1)
    expect(bottomLeft[0]!.produce()).toEqual([{ text: "tasks: 2", color: "info" }])

    expect(bottomRight.length).toBe(1)
    expect(bottomRight[0]!.produce()).toEqual([{ text: "v1.0", color: "textMuted" }])
  })

  test("sorts border labels by priority across positions", () => {
    const extensions: LoadedTuiExtension[] = [
      {
        id: "@test/a",
        kind: "user",
        filePath: "test:a",
        contributions: [
          borderLabelContribution({
            position: "bottom-left",
            priority: 200,
            produce: () => [{ text: "low", color: "" }],
          }),
          borderLabelContribution({
            position: "bottom-left",
            priority: 10,
            produce: () => [{ text: "high", color: "" }],
          }),
          borderLabelContribution({
            position: "top-left",
            priority: 50,
            produce: () => [{ text: "mid", color: "" }],
          }),
        ],
      },
    ]

    const resolved = resolveTuiExtensions(extensions)
    // Should be sorted: priority 10, 50, 200
    expect(resolved.borderLabels.map((l) => l.priority)).toEqual([10, 50, 200])
  })
})

describe("resolution semantics", () => {
  test("higher scope wins keybind and lower scope keeps the command without the keybind", () => {
    const resolved = resolveTuiExtensions([
      {
        id: "@test/user",
        kind: "user",
        filePath: "/test/user",
        contributions: [
          clientCommandContribution({
            id: "cmd-u",
            title: "User",
            keybind: "ctrl+k",
            onSelect: () => {},
          }),
        ],
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        contributions: [
          clientCommandContribution({
            id: "cmd-p",
            title: "Project",
            keybind: "ctrl+k",
            onSelect: () => {},
          }),
        ],
      } satisfies LoadedTuiExtension,
    ])

    const userCommand = resolved.commands.find((command) => command.id === "cmd-u")
    const projectCommand = resolved.commands.find((command) => command.id === "cmd-p")
    expect(userCommand?.keybind).toBeUndefined()
    expect(projectCommand?.keybind).toBe("ctrl+k")
  })

  test("higher scope wins slash and lower scope keeps the command without the slash", () => {
    const resolved = resolveTuiExtensions([
      {
        id: "@test/user",
        kind: "user",
        filePath: "/test/user",
        contributions: [
          clientCommandContribution({
            id: "cmd-u",
            title: "User",
            slash: "deploy",
            onSelect: () => {},
          }),
        ],
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        contributions: [
          clientCommandContribution({
            id: "cmd-p",
            title: "Project",
            slash: "deploy",
            onSelect: () => {},
          }),
        ],
      } satisfies LoadedTuiExtension,
    ])

    const userCommand = resolved.commands.find((command) => command.id === "cmd-u")
    const projectCommand = resolved.commands.find((command) => command.id === "cmd-p")
    expect(userCommand?.slash).toBeUndefined()
    expect(projectCommand?.slash).toBe("deploy")
  })

  test("higher scope wins composer surface", () => {
    const resolved = resolveTuiExtensions([
      {
        id: "@test/user",
        kind: "user",
        filePath: "/test/user",
        contributions: [composerSurfaceContribution(() => "user-composer")],
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        contributions: [composerSurfaceContribution(() => "project-composer")],
      } satisfies LoadedTuiExtension,
    ])

    expect((resolved.composerSurface as () => string)?.()).toBe("project-composer")
  })

  test("same-scope composer surface collision throws", () => {
    expect(() =>
      resolveTuiExtensions([
        {
          id: "@test/a",
          kind: "user",
          filePath: "/test/a",
          contributions: [composerSurfaceContribution(() => "a")],
        } satisfies LoadedTuiExtension,
        {
          id: "@test/b",
          kind: "user",
          filePath: "/test/b",
          contributions: [composerSurfaceContribution(() => "b")],
        } satisfies LoadedTuiExtension,
      ]),
    ).toThrow("Same-scope TUI composer surface collision")
  })

  test("interaction renderers resolve with precedence and collide within scope", () => {
    const resolved = resolveTuiExtensions([
      {
        id: "@test/builtin",
        kind: "builtin",
        filePath: "builtin:@test/builtin",
        contributions: [interactionRendererContribution(() => "builtin", "ask-user")],
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        contributions: [interactionRendererContribution(() => "project", "ask-user")],
      } satisfies LoadedTuiExtension,
    ])

    expect((resolved.interactionRenderers.get("ask-user") as () => string)?.()).toBe("project")
    expect(() =>
      resolveTuiExtensions([
        {
          id: "@test/a",
          kind: "user",
          filePath: "/test/a",
          contributions: [interactionRendererContribution(() => "a", "ask-user")],
        } satisfies LoadedTuiExtension,
        {
          id: "@test/b",
          kind: "user",
          filePath: "/test/b",
          contributions: [interactionRendererContribution(() => "b", "ask-user")],
        } satisfies LoadedTuiExtension,
      ]),
    ).toThrow("Same-scope TUI interaction renderer collision")
  })

  test("slashPriority is preserved through resolve", () => {
    const resolved = resolveTuiExtensions([
      {
        id: "@test/ext",
        kind: "builtin",
        filePath: "builtin:@test/ext",
        contributions: [
          clientCommandContribution({
            id: "custom-clear",
            title: "Custom Clear",
            slash: "clear",
            slashPriority: -1,
            onSelect: () => {},
          }),
        ],
      } satisfies LoadedTuiExtension,
    ])

    const cmd = resolved.commands.find((c) => c.id === "custom-clear")
    expect(cmd).toBeDefined()
    expect(cmd!.slashPriority).toBe(-1)
    expect(cmd!.slash).toBe("clear")
  })

  test("paletteLevel factory is preserved through resolve", () => {
    const levelFactory = () => ({
      id: "custom-level",
      title: "Custom",
      source: () => [{ id: "item1", title: "Item 1", onSelect: () => {} }],
    })

    const resolved = resolveTuiExtensions([
      {
        id: "@test/ext",
        kind: "builtin",
        filePath: "builtin:@test/ext",
        contributions: [
          clientCommandContribution({
            id: "open-custom",
            title: "Open Custom",
            paletteLevel: levelFactory,
            onSelect: () => {},
          }),
        ],
      } satisfies LoadedTuiExtension,
    ])

    const cmd = resolved.commands.find((c) => c.id === "open-custom")
    expect(cmd).toBeDefined()
    expect(cmd!.paletteLevel).toBe(levelFactory)
    const level = cmd!.paletteLevel!()
    expect(level.id).toBe("custom-level")
    expect(level.source()).toHaveLength(1)
  })
})

describe("composerState contract", () => {
  test("extension setup can register commands (Effect-typed setup)", async () => {
    const composerDir = join(TEST_DIR, "composer-ext")
    mkdirSync(composerDir, { recursive: true })
    writeFileSync(
      join(composerDir, "composer.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/composer-reader",
  setup: Effect.succeed([{
    _tag: "command",
    id: "test-composer-state",
    title: "Test",
    onSelect: () => {},
  }]),
}`,
    )

    // Should not throw — Effect-typed setup resolves via runtime
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: composerDir,
      projectDir: join(TEST_DIR, "no-project"),
    })

    const cmd = resolved.commands.find((c) => c.id === "test-composer-state")
    expect(cmd).toBeDefined()

    rmSync(composerDir, { recursive: true, force: true })
  })
})

describe("autocompleteItems resolution", () => {
  test("extension with autocompleteItems contributes to resolved output", () => {
    const resolved = resolveTuiExtensions([
      {
        id: "@test/ac",
        kind: "builtin",
        filePath: "builtin:@test/ac",
        contributions: [
          autocompleteContribution({
            prefix: "#",
            title: "Tags",
            items: () => [{ id: "tag1", label: "tag1" }],
          }),
        ],
      } satisfies LoadedTuiExtension,
    ])

    expect(resolved.autocompleteItems).toHaveLength(1)
    expect(resolved.autocompleteItems[0]!.prefix).toBe("#")
    expect(resolved.autocompleteItems[0]!.title).toBe("Tags")
  })

  test("multiple contributions for same prefix are collected", () => {
    const resolved = resolveTuiExtensions([
      {
        id: "@test/a",
        kind: "builtin",
        filePath: "builtin:@test/a",
        contributions: [
          autocompleteContribution({ prefix: "$", title: "Skills A", items: () => [] }),
        ],
      } satisfies LoadedTuiExtension,
      {
        id: "@test/b",
        kind: "user",
        filePath: "/test/b",
        contributions: [
          autocompleteContribution({ prefix: "$", title: "Skills B", items: () => [] }),
        ],
      } satisfies LoadedTuiExtension,
    ])

    const dollarContribs = resolved.autocompleteItems.filter((c) => c.prefix === "$")
    expect(dollarContribs).toHaveLength(2)
  })

  test("builtin skills, files, and commands contribute correct prefixes", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: join(TEST_DIR, "empty-user-ac"),
      projectDir: join(TEST_DIR, "empty-project-ac"),
    })

    // $ and @ come from extension autocomplete contributions
    // / is derived from the command registry at runtime by session-controller
    const prefixes = new Set(resolved.autocompleteItems.map((c) => c.prefix))
    expect(prefixes.has("$")).toBe(true)
    expect(prefixes.has("@")).toBe(true)
  })
})

// B11.6 regression: when the TUI starts with `--continue` or `--session`,
// `currentSession()` returns a real session BEFORE setup runs. The migrated
// auto/artifacts/tasks widgets must not crash in their session-change
// `createEffect` (caught one TDZ bug here in counsel; this test pins the
// invariant so future migrations can't reintroduce it).
describe("B11.6 transport-only widgets — startup with active session", () => {
  test("loadTuiExtensions does not throw when currentSession() returns a session at setup time", async () => {
    const activeSessionRuntime = ManagedRuntime.make(
      Layer.mergeAll(
        BunFileSystem.layer,
        BunServices.layer,
        makeClientWorkspaceLayer({ cwd: "/tmp/test-cwd", home: "/tmp/test-home" }),
        makeClientShellLayer({
          send: () => {},
          sendMessage: () => {},
          openOverlay: () => {},
          closeOverlay: () => {},
        }),
        makeClientComposerLayer({
          state: () => ({
            draft: "",
            mode: "editing" as const,
            inputFocused: false,
            autocompleteOpen: false,
          }),
        }),
        makeClientTransportLayer({
          // Stub client+runtime — every transport call still fails loudly
          // via `runtime.run`, but the client surface stays structurally
          // complete so startup doesn't explode before the async boundary.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client: {
            extension: {
              ask: () => Effect.void,
              request: () => Effect.void,
              listCommands: () => Effect.succeed([]),
            },
          } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runtime: { run: () => Promise.reject(new Error("no transport in test")) } as any,
          // The key bit: a session is already active when setup runs.
          currentSession: () => ({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            sessionId: "test-session-id" as never,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            branchId: "test-branch-id" as never,
          }),
          onExtensionStateChanged: () => () => {},
        }),
        makeClientLifecycleLayer({ addCleanup: () => {} }),
      ),
    )

    const emptyUser = join(TEST_DIR, "active-session-test-user")
    const emptyProject = join(TEST_DIR, "active-session-test-project")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    // Capture console.warn so the swallowed refetch errors don't pollute
    // the test output noise.
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const resolved = await loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: emptyUser,
        projectDir: emptyProject,
        runtime: activeSessionRuntime,
      })
      // Sanity: widgets we explicitly migrated to transport-only loaded.
      const widgetIds = new Set(resolved.widgets.map((w) => w.id))
      expect(widgetIds.has("tasks")).toBe(true)
      // Auto + artifacts contribute border labels rather than widgets.
      // If their setup threw, none of the resolved bundle exists.
      const borderPositions = new Set(resolved.borderLabels.map((b) => b.position))
      expect(borderPositions.has("top-left")).toBe(true) // auto
      expect(borderPositions.has("bottom-right")).toBe(true) // artifacts
      expect(borderPositions.has("bottom-left")).toBe(true) // tasks
    } finally {
      console.warn = originalWarn
      rmSync(emptyUser, { recursive: true, force: true })
      rmSync(emptyProject, { recursive: true, force: true })
      await activeSessionRuntime.dispose()
    }
  })
})
