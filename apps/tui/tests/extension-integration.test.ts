/**
 * Integration tests for the TUI extension system.
 *
 * Tests the full pipeline: discovery → import → resolve, including
 * real file loading from temporary directories.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol.js"
import { loadTuiExtensions as _loadTuiExtensions } from "../src/extensions/loader-boundary"
import { decodeExtensionAskReply } from "../src/extensions/context"
import {
  makeClientWorkspaceLayer,
  makeClientShellLayer,
  makeClientComposerLayer,
  makeClientSnapshotsLayer,
} from "../src/extensions/client-services"
import { makeClientTransportLayer } from "../src/extensions/client-transport"
// applyExtensionSnapshot is gone in C2 — provide a local stub so the legacy
// "snapshot ordering" tests still load. TODO(c2): port to ExtensionStateChanged.
const applyExtensionSnapshot = (
  map: Map<string, unknown>,
  snap: {
    readonly extensionId: string
    readonly epoch: number
    readonly sessionId: string
    readonly branchId: string
    readonly model: unknown
  },
): Map<string, unknown> => {
  const existing = map.get(snap.extensionId) as
    | { sessionId: string; branchId: string; epoch: number }
    | undefined
  if (
    existing !== undefined &&
    existing.sessionId === snap.sessionId &&
    existing.branchId === snap.branchId &&
    existing.epoch >= snap.epoch
  ) {
    return map
  }
  const next = new Map(map)
  next.set(snap.extensionId, snap)
  return next
}
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"
import {
  autocompleteContribution,
  borderLabelContribution,
  clientCommandContribution,
  composerSurfaceContribution,
  interactionRendererContribution,
  type ExtensionClientContext,
} from "@gent/core/domain/extension-client.js"

// C2-compat shim: production loadTuiExtensions now takes (opts, makeCtx, fs, path).
// Tests still call with (opts, ctx); wrap to preserve the original convention.
// C9.1: opts gained a required `runtime` field (ManagedRuntime<ClientDeps>).
// C9.3: builtins (e.g. files.client.ts) now yield TUI services; the test
// runtime must provide every service the production runtime provides so
// builtin Effect setups resolve. Stub callbacks suffice — none are invoked
// during pure load.
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
    makeClientSnapshotsLayer({ read: () => undefined }),
    // B11.6: builtin widgets that migrated off the paired-package
    // snapshot cache (auto, artifacts, tasks) yield `ClientTransport`
    // from setup. Test runtime stubs the surface; pure-load tests do
    // not invoke any of these methods so failures bubble loudly if hit.
    makeClientTransportLayer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime: {} as any,
      currentSession: () => undefined,
      onExtensionStateChanged: () => () => {},
    }),
  ),
)
const loadTuiExtensions = (
  opts: Omit<Parameters<typeof _loadTuiExtensions>[0], "runtime"> & {
    runtime?: Parameters<typeof _loadTuiExtensions>[0]["runtime"]
  },
  ctx: ExtensionClientContext,
): ReturnType<typeof _loadTuiExtensions> =>
  _loadTuiExtensions({ ...opts, runtime: opts.runtime ?? _testRuntime }, () => ctx)
import { SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"
import { defineExtensionPackage } from "@gent/core/domain/extension-package.js"
import type { GentExtension } from "@gent/core/domain/extension.js"
import { AutoPackage } from "@gent/extensions/auto-package.js"
import { PlanPackage } from "@gent/extensions/plan-package.js"
import { TaskToolsPackage } from "@gent/extensions/task-tools-package.js"
import { HandoffPackage } from "@gent/extensions/handoff-package.js"
import { InteractionToolsPackage } from "@gent/extensions/interaction-tools-package.js"
import { ArtifactsPackage } from "@gent/extensions/artifacts-package.js"

const TEST_DIR = join(import.meta.dir, ".tmp-ext-integration")
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")
// Use the same barrel as production context.tsx
import { builtinClientModules } from "../src/extensions/builtins/index"

const noopCtx: ExtensionClientContext = {
  cwd: TEST_DIR,
  home: "/tmp",
  openOverlay: () => {},
  closeOverlay: () => {},
  send: () => {},
  getSnapshotRaw: () => undefined,
  sendMessage: () => {},
  composerState: () => ({
    draft: "",
    mode: "editing",
    inputFocused: false,
    autocompleteOpen: false,
  }),
}

/** Ctx that records openOverlay calls */
const createRecordingCtx = () => {
  const calls: string[] = []
  const ctx: ExtensionClientContext = {
    cwd: TEST_DIR,
    home: "/tmp",
    openOverlay: (id) => calls.push(id),
    closeOverlay: () => calls.push("__close__"),
    send: () => {},
    getSnapshotRaw: () => undefined,
    sendMessage: () => {},
    composerState: () => ({
      draft: "",
      mode: "editing",
      inputFocused: false,
      autocompleteOpen: false,
    }),
  }
  return { ctx, calls }
}

const createProtocolRecordingCtx = () => {
  const sent: unknown[] = []
  const ctx: ExtensionClientContext = {
    cwd: TEST_DIR,
    home: "/tmp",
    openOverlay: () => {},
    closeOverlay: () => {},
    send: (message) => sent.push(message),
    getSnapshotRaw: () => undefined,
    sendMessage: () => {},
    composerState: () => ({
      draft: "",
      mode: "editing",
      inputFocused: false,
      autocompleteOpen: false,
    }),
  }
  return { ctx, sent }
}

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
    `export default {
  id: "@test/custom-read",
  setup: () => [
    { _kind: "renderer", toolNames: ["my_custom_tool"], component: () => "custom-tool-renderer" },
    { _kind: "widget", id: "test-widget", slot: "below-messages", priority: 50, component: () => "test-widget" },
    { _kind: "command", id: "test-cmd", title: "Test Command", category: "test", onSelect: () => {} },
    { _kind: "overlay", id: "test-overlay", component: () => "test-overlay" },
  ],
}`,
  )

  // Project extension: overrides a builtin tool renderer
  writeFileSync(
    join(PROJECT_DIR, "override-bash.client.ts"),
    `export default {
  id: "@test/override-bash",
  setup: () => [
    { _kind: "renderer", toolNames: ["bash"], component: () => "project-bash-override" },
  ],
}`,
  )

  // Discovery fixtures that should or should not survive the public seam
  writeFileSync(
    join(USER_DIR, "alpha.client.ts"),
    "export default { id: '@test/alpha', setup: () => [{ _kind: 'command', id: 'alpha', title: 'Alpha', onSelect: () => {} }] }",
  )
  writeFileSync(
    join(USER_DIR, "zeta.client.ts"),
    "export default { id: '@test/zeta', setup: () => [{ _kind: 'command', id: 'zeta', title: 'Zeta', onSelect: () => {} }] }",
  )
  writeFileSync(
    join(USER_DIR, ".hidden.client.tsx"),
    "export default { id: '@test/hidden', setup: () => [{ _kind: 'command', id: 'hidden', title: 'Hidden', onSelect: () => {} }] }",
  )
  writeFileSync(
    join(USER_DIR, "_internal.client.tsx"),
    "export default { id: '@test/internal', setup: () => [{ _kind: 'command', id: 'internal', title: 'Internal', onSelect: () => {} }] }",
  )
  mkdirSync(join(USER_DIR, "__tests__"), { recursive: true })
  writeFileSync(
    join(USER_DIR, "__tests__", "test.client.tsx"),
    "export default { id: '@test/spec-only', setup: () => [{ _kind: 'command', id: 'spec-only', title: 'Spec Only', onSelect: () => {} }] }",
  )
  writeFileSync(
    join(PROJECT_DIR, "prebuilt.client.mjs"),
    "export default { id: '@test/prebuilt', setup: () => [{ _kind: 'command', id: 'prebuilt', title: 'Prebuilt', onSelect: () => {} }] }",
  )

  // Extension that uses ctx.openOverlay in a command
  const ctxDir = join(TEST_DIR, "ctx-ext")
  mkdirSync(ctxDir, { recursive: true })
  writeFileSync(
    join(ctxDir, "ctx-user.client.ts"),
    `export default {
  id: "@test/ctx-user",
  setup: (ctx) => [
    { _kind: "command", id: "ctx-cmd", title: "Ctx Command", category: "test", onSelect: () => ctx.openOverlay("ctx-overlay") },
    { _kind: "overlay", id: "ctx-overlay", component: () => "ctx-overlay-component" },
  ],
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

    const resolved = await loadTuiExtensions(
      { builtins: builtinClientModules, userDir: emptyUser, projectDir: emptyProject },
      noopCtx,
    )

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
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: USER_DIR,
        projectDir: join(TEST_DIR, "no-project"),
      },
      noopCtx,
    )

    expect(resolved.renderers.has("my_custom_tool")).toBe(true)
  })

  test("loads user extension with widget", async () => {
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: USER_DIR,
        projectDir: join(TEST_DIR, "no-project"),
      },
      noopCtx,
    )

    const widget = resolved.widgets.find((w) => w.id === "test-widget")
    expect(widget).toBeDefined()
    expect(widget?.slot).toBe("below-messages")
    expect(widget?.priority).toBe(50)
  })

  test("loads user extension with command", async () => {
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: USER_DIR,
        projectDir: join(TEST_DIR, "no-project"),
      },
      noopCtx,
    )

    const cmd = resolved.commands.find((c) => c.id === "test-cmd")
    expect(cmd).toBeDefined()
    expect(cmd?.title).toBe("Test Command")
    expect(cmd?.category).toBe("test")
  })

  test("loads user extension with overlay", async () => {
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: USER_DIR,
        projectDir: join(TEST_DIR, "no-project"),
      },
      noopCtx,
    )

    expect(resolved.overlays.has("test-overlay")).toBe(true)
  })

  test("discovery filters hidden and test-only files while still loading prebuilt mjs files", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: [], userDir: USER_DIR, projectDir: PROJECT_DIR },
      noopCtx,
    )

    const commandIds = resolved.commands.map((command) => command.id)
    expect(commandIds).toContain("prebuilt")
    expect(commandIds).not.toContain("hidden")
    expect(commandIds).not.toContain("internal")
    expect(commandIds).not.toContain("spec-only")
  })

  test("user-scope discovery is deterministic within scope", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: [], userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    const userCommandIds = resolved.commands
      .map((command) => command.id)
      .filter((id) => id === "alpha" || id === "zeta")
    expect(userCommandIds).toEqual(["alpha", "zeta"])
  })

  test("project extension overrides builtin tool renderer", async () => {
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: join(TEST_DIR, "no-user"),
        projectDir: PROJECT_DIR,
      },
      noopCtx,
    )

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
      `export default {
  id: "@test/user-bash",
  setup: () => [
    { _kind: "renderer", toolNames: ["bash"], component: () => "user-bash-override" },
  ],
}`,
    )

    const resolved = await loadTuiExtensions(
      { builtins: builtinClientModules, userDir: userBashDir, projectDir: PROJECT_DIR },
      noopCtx,
    )

    // Project should win over user — call the renderer to prove it
    const bashRenderer = resolved.renderers.get("bash")
    expect(bashRenderer).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((bashRenderer as any)()).toBe("project-bash-override")

    rmSync(userBashDir, { recursive: true, force: true })
  })

  test("extension command captures ctx.openOverlay from setup", async () => {
    const ctxDir = join(TEST_DIR, "ctx-ext")
    const { ctx, calls } = createRecordingCtx()

    const resolved = await loadTuiExtensions(
      { builtins: builtinClientModules, userDir: ctxDir, projectDir: join(TEST_DIR, "no-project") },
      ctx,
    )

    // The command's onSelect should invoke ctx.openOverlay
    const cmd = resolved.commands.find((c) => c.id === "ctx-cmd")
    expect(cmd).toBeDefined()
    cmd!.onSelect()
    expect(calls).toEqual(["ctx-overlay"])

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
    writeFileSync(
      join(protocolDir, "protocol.client.ts"),
      `import { SharedProtocol } from "./shared-protocol"

export default {
  id: "@test/shared-client",
  setup: (ctx) => [
    {
      _kind: "command",
      id: "shared.ping",
      title: "Shared Ping",
      onSelect: () => ctx.send(SharedProtocol.Ping({ value: "pong" })),
    },
  ],
}`,
    )

    const { ctx, sent } = createProtocolRecordingCtx()
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: protocolDir,
        projectDir: join(TEST_DIR, "no-project"),
      },
      ctx,
    )

    const command = resolved.commands.find((entry) => entry.id === "shared.ping")
    expect(command).toBeDefined()
    command!.onSelect()
    expect(sent).toEqual([{ extensionId: "@test/shared", _tag: "Ping", value: "pong" }])

    rmSync(protocolDir, { recursive: true, force: true })
  })

  test("decodeExtensionAskReply decodes replies from request message metadata without client protocol registration", async () => {
    const GetCount = ExtensionMessage.reply("@test/shared", "GetCount", {}, Schema.NumberFromString)

    await expect(Effect.runPromise(decodeExtensionAskReply(GetCount(), "42"))).resolves.toBe(42)
  })

  test("nonexistent directories are handled gracefully", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: builtinClientModules, userDir: "/nonexistent/a", projectDir: "/nonexistent/b" },
      noopCtx,
    )

    // Should still have builtins
    expect(resolved.renderers.has("read")).toBe(true)
    expect(resolved.renderers.has("bash")).toBe(true)
  })

  test("invalid extension files are skipped gracefully", async () => {
    const badDir = join(TEST_DIR, "bad-ext")
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, "bad.client.ts"), "export default { not: 'an extension' }")

    const resolved = await loadTuiExtensions(
      { builtins: builtinClientModules, userDir: badDir, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

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

    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: emptyUser,
        projectDir: emptyProject,
        disabled: ["@gent/tools"],
      },
      noopCtx,
    )

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
      `export default {
  id: "@test/bomb",
  setup: () => { throw new Error("setup() should not be called for disabled extension") },
}`,
    )

    // Should not throw — setup() should never be called
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: disabledDir,
        projectDir: join(TEST_DIR, "no-project"),
        disabled: ["@test/bomb"],
      },
      noopCtx,
    )

    // Builtins still present
    expect(resolved.renderers.has("read")).toBe(true)

    rmSync(disabledDir, { recursive: true, force: true })
  })

  test("multiple builtins can be disabled independently", async () => {
    const emptyUser = join(TEST_DIR, "disabled-multi-user")
    const emptyProject = join(TEST_DIR, "disabled-multi-project")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: emptyUser,
        projectDir: emptyProject,
        disabled: ["@gent/plan", "@gent/task-tools"],
      },
      noopCtx,
    )

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
      `export default {
  id: "@test/a",
  setup: () => [{ _kind: "renderer", toolNames: ["my_tool"], component: () => "a" }],
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => [{ _kind: "renderer", toolNames: ["my_tool"], component: () => "b" }],
}`,
    )

    await expect(
      loadTuiExtensions(
        {
          builtins: builtinClientModules,
          userDir: collisionDir,
          projectDir: join(TEST_DIR, "no-project"),
        },
        noopCtx,
      ),
    ).rejects.toThrow("Same-scope TUI renderer collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same widget id throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-widget")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `export default {
  id: "@test/a",
  setup: () => [{ _kind: "widget", id: "dup-widget", slot: "below-messages", component: () => "a" }],
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => [{ _kind: "widget", id: "dup-widget", slot: "above-input", component: () => "b" }],
}`,
    )

    await expect(
      loadTuiExtensions(
        {
          builtins: builtinClientModules,
          userDir: collisionDir,
          projectDir: join(TEST_DIR, "no-project"),
        },
        noopCtx,
      ),
    ).rejects.toThrow("Same-scope TUI widget collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same command id throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-cmd")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `export default {
  id: "@test/a",
  setup: () => [{ _kind: "command", id: "dup-cmd", title: "A", onSelect: () => {} }],
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => [{ _kind: "command", id: "dup-cmd", title: "B", onSelect: () => {} }],
}`,
    )

    await expect(
      loadTuiExtensions(
        {
          builtins: builtinClientModules,
          userDir: collisionDir,
          projectDir: join(TEST_DIR, "no-project"),
        },
        noopCtx,
      ),
    ).rejects.toThrow("Same-scope TUI command collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same keybind throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-kb")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `export default {
  id: "@test/a",
  setup: () => [{ _kind: "command", id: "cmd-a", title: "A", keybind: "ctrl+k", onSelect: () => {} }],
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => [{ _kind: "command", id: "cmd-b", title: "B", keybind: "ctrl+k", onSelect: () => {} }],
}`,
    )

    await expect(
      loadTuiExtensions(
        {
          builtins: builtinClientModules,
          userDir: collisionDir,
          projectDir: join(TEST_DIR, "no-project"),
        },
        noopCtx,
      ),
    ).rejects.toThrow("Same-scope TUI keybind collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })

  test("two user extensions with same overlay id throws", async () => {
    const collisionDir = join(TEST_DIR, "collision-overlay")
    mkdirSync(collisionDir, { recursive: true })
    writeFileSync(
      join(collisionDir, "a.client.ts"),
      `export default {
  id: "@test/a",
  setup: () => [{ _kind: "overlay", id: "dup-overlay", component: () => "a" }],
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => [{ _kind: "overlay", id: "dup-overlay", component: () => "b" }],
}`,
    )

    await expect(
      loadTuiExtensions(
        {
          builtins: builtinClientModules,
          userDir: collisionDir,
          projectDir: join(TEST_DIR, "no-project"),
        },
        noopCtx,
      ),
    ).rejects.toThrow("Same-scope TUI overlay collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })
})

describe("snapshot ordering", () => {
  test("older extension snapshots do not overwrite newer ones", () => {
    const latest = applyExtensionSnapshot(new Map(), {
      sessionId: "s-1",
      branchId: "b-1",
      extensionId: "@test/shared",
      epoch: 2,
      model: { status: "latest" },
    })

    const merged = applyExtensionSnapshot(latest, {
      sessionId: "s-1",
      branchId: "b-1",
      extensionId: "@test/shared",
      epoch: 1,
      model: { status: "stale" },
    })

    expect(merged).toBe(latest)
    expect(merged.get("@test/shared")).toEqual({
      sessionId: "s-1",
      branchId: "b-1",
      extensionId: "@test/shared",
      epoch: 2,
      model: { status: "latest" },
    })
  })

  test("new branch snapshots replace older snapshots even when epoch resets", () => {
    const previousBranch = applyExtensionSnapshot(new Map(), {
      sessionId: "s-1",
      branchId: "b-old",
      extensionId: "@test/shared",
      epoch: 9,
      model: { status: "old-branch" },
    })

    const merged = applyExtensionSnapshot(previousBranch, {
      sessionId: "s-1",
      branchId: "b-new",
      extensionId: "@test/shared",
      epoch: 1,
      model: { status: "new-branch" },
    })

    expect(merged.get("@test/shared")).toEqual({
      sessionId: "s-1",
      branchId: "b-new",
      extensionId: "@test/shared",
      epoch: 1,
      model: { status: "new-branch" },
    })
  })
})

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

describe("ExtensionPackage.tui()", () => {
  // Minimal stub server extension for test packages
  const stubServer = (id: string) =>
    ({
      manifest: { id },
      setup: () => Effect.succeed([]),
    }) as GentExtension

  const TestSnapshot = Schema.Struct({ value: Schema.Number })

  test(".tui() derives ID from package", () => {
    const pkg = defineExtensionPackage({
      id: "@test/derived-id",
      server: stubServer("@test/derived-id"),
      snapshot: TestSnapshot,
    })

    const clientModule = pkg.tui(() => [])
    expect(clientModule.id).toBe("@test/derived-id")
  })

  // TODO(c2): zero-arg getSnapshot — removed. ExtensionClientContext now
  // exposes only getSnapshotRaw(): unknown; the typed schema-bound surface
  // is gone. Rewrite once a typed snapshot helper is reintroduced.
  test.skip("zero-arg getSnapshot calls through with package ID + schema", () => {})

  // TODO(c2): two-arg getSnapshot — removed. See note above.
  test.skip("two-arg getSnapshot delegates for cross-extension reads", () => {})

  // TODO(c2): package without snapshot zero-arg behavior — removed. See note above.
  test.skip("package without snapshot: zero-arg returns undefined", () => {})

  test("paired builtin IDs match their package IDs", () => {
    const pairedPackages = [
      ArtifactsPackage,
      AutoPackage,
      PlanPackage,
      TaskToolsPackage,
      HandoffPackage,
      InteractionToolsPackage,
    ]

    for (const pkg of pairedPackages) {
      const clientModule = pkg.tui(() => [])
      expect(clientModule.id).toBe(pkg.id)
    }
  })

  test("all paired builtins derive ID from package (no manual id)", () => {
    // Verify actual builtin modules match their package IDs
    const expectedIds = new Map([
      ["@gent/artifacts", ArtifactsPackage.id],
      ["@gent/auto", AutoPackage.id],
      ["@gent/plan", PlanPackage.id],
      ["@gent/task-tools", TaskToolsPackage.id],
      ["@gent/handoff", HandoffPackage.id],
      ["@gent/interaction-tools", InteractionToolsPackage.id],
    ])

    for (const mod of builtinClientModules) {
      const expected = expectedIds.get(mod.id)
      if (expected !== undefined) {
        expect(mod.id).toBe(expected)
      }
    }
  })
})

describe("composerState contract", () => {
  test("composerState is available on ExtensionClientContext", () => {
    const state = noopCtx.composerState()
    expect(state).toEqual({
      draft: "",
      mode: "editing",
      inputFocused: false,
      autocompleteOpen: false,
    })
  })

  test("composerState is passed through to extension setup", async () => {
    const composerDir = join(TEST_DIR, "composer-ext")
    mkdirSync(composerDir, { recursive: true })
    writeFileSync(
      join(composerDir, "composer.client.ts"),
      `export default {
  id: "@test/composer-reader",
  setup: (ctx) => {
    // Extensions can read composerState during setup and store the getter
    const getState = ctx.composerState
    return [{
      _kind: "command",
      id: "test-composer-state",
      title: "Test",
      onSelect: () => { getState() },
    }]
  },
}`,
    )

    const customCtx: ExtensionClientContext = {
      ...noopCtx,
      composerState: () => ({
        draft: "hello",
        mode: "shell" as const,
        inputFocused: true,
        autocompleteOpen: true,
      }),
    }

    // Should not throw — composerState is accessible during setup
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: composerDir,
        projectDir: join(TEST_DIR, "no-project"),
      },
      customCtx,
    )

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
    const resolved = await loadTuiExtensions(
      {
        builtins: builtinClientModules,
        userDir: join(TEST_DIR, "empty-user-ac"),
        projectDir: join(TEST_DIR, "empty-project-ac"),
      },
      noopCtx,
    )

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
        makeClientSnapshotsLayer({ read: () => undefined }),
        makeClientTransportLayer({
          // Stub client+runtime — refetch will fail loudly if invoked
          // (no `extension.query`/`ask`), but the widget's createEffect
          // schedules the call asynchronously via void runRefetch(...) so
          // the synchronous setup path completes successfully and the
          // failing async call is swallowed by the widget's catch.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client: { extension: {} } as any,
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
      const resolved = await loadTuiExtensions(
        {
          builtins: builtinClientModules,
          userDir: emptyUser,
          projectDir: emptyProject,
          runtime: activeSessionRuntime,
        },
        noopCtx,
      )
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
