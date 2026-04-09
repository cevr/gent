/**
 * Integration tests for the TUI extension system.
 *
 * Tests the full pipeline: discovery → import → resolve, including
 * real file loading from temporary directories.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol.js"
import { loadTuiExtensions } from "../src/extensions/loader"
import { applyExtensionSnapshot, decodeExtensionAskReply } from "../src/extensions/context"
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"
import type { ExtensionClientContext } from "@gent/core/domain/extension-client.js"
import { SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"
import { defineExtensionPackage } from "@gent/core/domain/extension-package.js"
import type { GentExtension } from "@gent/core/domain/extension.js"
import { AutoPackage } from "@gent/core/extensions/auto-package.js"
import { PlanPackage } from "@gent/core/extensions/plan-package.js"
import { TaskToolsPackage } from "@gent/core/extensions/task-tools-package.js"
import { HandoffPackage } from "@gent/core/extensions/handoff-package.js"
import { InteractionToolsPackage } from "@gent/core/extensions/interaction-tools-package.js"

const TEST_DIR = join(import.meta.dir, ".tmp-ext-integration")
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")
// Use the same barrel as production context.tsx
import { builtinClientModules } from "../src/extensions/builtins/index"

const noopCtx: ExtensionClientContext = {
  cwd: TEST_DIR,
  openOverlay: () => {},
  closeOverlay: () => {},
  send: () => {},
  ask: async () => undefined,
  getSnapshot: () => undefined,
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
    openOverlay: (id) => calls.push(id),
    closeOverlay: () => calls.push("__close__"),
    send: () => {},
    ask: async () => undefined,
    getSnapshot: () => undefined,
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
    openOverlay: () => {},
    closeOverlay: () => {},
    send: (message) => sent.push(message),
    ask: async () => undefined,
    getSnapshot: () => undefined,
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

  // User extension: custom tool renderer
  mkdirSync(join(USER_DIR, "custom-read"), { recursive: true })
  writeFileSync(
    join(USER_DIR, "custom-read", "index.ts"),
    `// server-side extension (should be skipped by TUI discovery)
export default { manifest: { id: "custom-read" }, setup: () => ({ tools: [] }) }`,
  )
  writeFileSync(
    join(USER_DIR, "custom-read", "client.ts"),
    `export default {
  id: "@test/custom-read",
  setup: () => ({
    tools: [{ toolNames: ["my_custom_tool"], component: () => "custom-tool-renderer" }],
    widgets: [{ id: "test-widget", slot: "below-messages", priority: 50, component: () => "test-widget" }],
    commands: [{ id: "test-cmd", title: "Test Command", category: "test", onSelect: () => {} }],
    overlays: [{ id: "test-overlay", component: () => "test-overlay" }],
  }),
}`,
  )

  // Project extension: overrides a builtin tool renderer
  writeFileSync(
    join(PROJECT_DIR, "override-bash.client.ts"),
    `export default {
  id: "@test/override-bash",
  setup: () => ({
    tools: [{ toolNames: ["bash"], component: () => "project-bash-override" }],
  }),
}`,
  )

  // Discovery fixtures that should or should not survive the public seam
  writeFileSync(
    join(USER_DIR, "alpha.client.ts"),
    "export default { id: '@test/alpha', setup: () => ({ commands: [{ id: 'alpha', title: 'Alpha', onSelect: () => {} }] }) }",
  )
  writeFileSync(
    join(USER_DIR, "zeta.client.ts"),
    "export default { id: '@test/zeta', setup: () => ({ commands: [{ id: 'zeta', title: 'Zeta', onSelect: () => {} }] }) }",
  )
  writeFileSync(
    join(USER_DIR, ".hidden.client.tsx"),
    "export default { id: '@test/hidden', setup: () => ({ commands: [{ id: 'hidden', title: 'Hidden', onSelect: () => {} }] }) }",
  )
  writeFileSync(
    join(USER_DIR, "_internal.client.tsx"),
    "export default { id: '@test/internal', setup: () => ({ commands: [{ id: 'internal', title: 'Internal', onSelect: () => {} }] }) }",
  )
  mkdirSync(join(USER_DIR, "__tests__"), { recursive: true })
  writeFileSync(
    join(USER_DIR, "__tests__", "test.client.tsx"),
    "export default { id: '@test/spec-only', setup: () => ({ commands: [{ id: 'spec-only', title: 'Spec Only', onSelect: () => {} }] }) }",
  )
  writeFileSync(
    join(PROJECT_DIR, "prebuilt.client.mjs"),
    "export default { id: '@test/prebuilt', setup: () => ({ commands: [{ id: 'prebuilt', title: 'Prebuilt', onSelect: () => {} }] }) }",
  )

  // Extension that uses ctx.openOverlay in a command
  const ctxDir = join(TEST_DIR, "ctx-ext")
  mkdirSync(ctxDir, { recursive: true })
  writeFileSync(
    join(ctxDir, "ctx-user.client.ts"),
    `export default {
  id: "@test/ctx-user",
  setup: (ctx) => ({
    commands: [{ id: "ctx-cmd", title: "Ctx Command", category: "test", onSelect: () => ctx.openOverlay("ctx-overlay") }],
    overlays: [{ id: "ctx-overlay", component: () => "ctx-overlay-component" }],
  }),
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
  setup: () => ({
    tools: [{ toolNames: ["bash"], component: () => "user-bash-override" }],
  }),
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
  setup: (ctx) => ({
    commands: [
      {
        id: "shared.ping",
        title: "Shared Ping",
        onSelect: () => ctx.send(SharedProtocol.Ping({ value: "pong" })),
      },
    ],
  }),
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

    // Other builtins should still be present
    const widgetIds = resolved.widgets.map((w) => w.id)
    expect(widgetIds).toContain("plan")

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
  setup: () => ({ tools: [{ toolNames: ["my_tool"], component: () => "a" }] }),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => ({ tools: [{ toolNames: ["my_tool"], component: () => "b" }] }),
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
  setup: () => ({ widgets: [{ id: "dup-widget", slot: "below-messages", component: () => "a" }] }),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => ({ widgets: [{ id: "dup-widget", slot: "above-input", component: () => "b" }] }),
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
  setup: () => ({ commands: [{ id: "dup-cmd", title: "A", onSelect: () => {} }] }),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => ({ commands: [{ id: "dup-cmd", title: "B", onSelect: () => {} }] }),
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
  setup: () => ({ commands: [{ id: "cmd-a", title: "A", keybind: "ctrl+k", onSelect: () => {} }] }),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => ({ commands: [{ id: "cmd-b", title: "B", keybind: "ctrl+k", onSelect: () => {} }] }),
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
  setup: () => ({ overlays: [{ id: "dup-overlay", component: () => "a" }] }),
}`,
    )
    writeFileSync(
      join(collisionDir, "b.client.ts"),
      `export default {
  id: "@test/b",
  setup: () => ({ overlays: [{ id: "dup-overlay", component: () => "b" }] }),
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
        setup: {
          borderLabels: [
            {
              position: "bottom-left",
              priority: 10,
              produce: () => [{ text: "tasks: 2", color: "info" }],
            },
            {
              position: "bottom-right",
              priority: 20,
              produce: () => [{ text: "v1.0", color: "textMuted" }],
            },
          ],
        },
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
        setup: {
          borderLabels: [
            { position: "bottom-left", priority: 200, produce: () => [{ text: "low", color: "" }] },
            { position: "bottom-left", priority: 10, produce: () => [{ text: "high", color: "" }] },
            { position: "top-left", priority: 50, produce: () => [{ text: "mid", color: "" }] },
          ],
        },
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
        setup: {
          commands: [{ id: "cmd-u", title: "User", keybind: "ctrl+k", onSelect: () => {} }],
        },
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        setup: {
          commands: [{ id: "cmd-p", title: "Project", keybind: "ctrl+k", onSelect: () => {} }],
        },
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
        setup: {
          commands: [{ id: "cmd-u", title: "User", slash: "deploy", onSelect: () => {} }],
        },
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        setup: {
          commands: [{ id: "cmd-p", title: "Project", slash: "deploy", onSelect: () => {} }],
        },
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
        setup: {
          composerSurface: () => "user-composer",
        },
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        setup: {
          composerSurface: () => "project-composer",
        },
      } satisfies LoadedTuiExtension,
    ])

    expect(resolved.composerSurface?.()).toBe("project-composer")
  })

  test("same-scope composer surface collision throws", () => {
    expect(() =>
      resolveTuiExtensions([
        {
          id: "@test/a",
          kind: "user",
          filePath: "/test/a",
          setup: { composerSurface: () => "a" },
        } satisfies LoadedTuiExtension,
        {
          id: "@test/b",
          kind: "user",
          filePath: "/test/b",
          setup: { composerSurface: () => "b" },
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
        setup: {
          interactionRenderers: [{ metadataType: "ask-user", component: () => "builtin" }],
        },
      } satisfies LoadedTuiExtension,
      {
        id: "@test/project",
        kind: "project",
        filePath: "/test/project",
        setup: {
          interactionRenderers: [{ metadataType: "ask-user", component: () => "project" }],
        },
      } satisfies LoadedTuiExtension,
    ])

    expect(resolved.interactionRenderers.get("ask-user")?.()).toBe("project")
    expect(() =>
      resolveTuiExtensions([
        {
          id: "@test/a",
          kind: "user",
          filePath: "/test/a",
          setup: {
            interactionRenderers: [{ metadataType: "ask-user", component: () => "a" }],
          },
        } satisfies LoadedTuiExtension,
        {
          id: "@test/b",
          kind: "user",
          filePath: "/test/b",
          setup: {
            interactionRenderers: [{ metadataType: "ask-user", component: () => "b" }],
          },
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
        setup: {
          commands: [
            {
              id: "custom-clear",
              title: "Custom Clear",
              slash: "clear",
              slashPriority: -1,
              onSelect: () => {},
            },
          ],
        },
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
        setup: {
          commands: [
            {
              id: "open-custom",
              title: "Open Custom",
              paletteLevel: levelFactory,
              onSelect: () => {},
            },
          ],
        },
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
      setup: () => Effect.succeed({}),
    }) as GentExtension

  const TestSnapshot = Schema.Struct({ value: Schema.Number })

  test(".tui() derives ID from package", () => {
    const pkg = defineExtensionPackage({
      id: "@test/derived-id",
      server: stubServer("@test/derived-id"),
      snapshot: TestSnapshot,
    })

    const clientModule = pkg.tui(() => ({}))
    expect(clientModule.id).toBe("@test/derived-id")
  })

  test("zero-arg getSnapshot calls through with package ID + schema", () => {
    const calls: Array<{ extensionId: string; schema: unknown }> = []
    const mockCtx: ExtensionClientContext = {
      ...noopCtx,
      getSnapshot: (extensionId: string, schema: unknown) => {
        calls.push({ extensionId, schema })
        return { value: 42 }
      },
    }

    const pkg = defineExtensionPackage({
      id: "@test/snapshot-bind",
      server: stubServer("@test/snapshot-bind"),
      snapshot: TestSnapshot,
    })

    const clientModule = pkg.tui((ctx) => {
      // Exercise zero-arg getSnapshot during setup
      const result = ctx.getSnapshot()
      expect(result).toEqual({ value: 42 })
      return {}
    })

    clientModule.setup(mockCtx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.extensionId).toBe("@test/snapshot-bind")
    expect(calls[0]!.schema).toBe(TestSnapshot)
  })

  test("two-arg getSnapshot delegates for cross-extension reads", () => {
    const OtherSchema = Schema.Struct({ other: Schema.String })
    const calls: Array<{ extensionId: string; schema: unknown }> = []
    const mockCtx: ExtensionClientContext = {
      ...noopCtx,
      getSnapshot: (extensionId: string, schema: unknown) => {
        calls.push({ extensionId, schema })
        return { other: "cross" }
      },
    }

    const pkg = defineExtensionPackage({
      id: "@test/cross-read",
      server: stubServer("@test/cross-read"),
      snapshot: TestSnapshot,
    })

    const clientModule = pkg.tui((ctx) => {
      const result = ctx.getSnapshot("@other/ext", OtherSchema)
      expect(result).toEqual({ other: "cross" })
      return {}
    })

    clientModule.setup(mockCtx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.extensionId).toBe("@other/ext")
    expect(calls[0]!.schema).toBe(OtherSchema)
  })

  test("package without snapshot: zero-arg returns undefined", () => {
    const pkg = defineExtensionPackage({
      id: "@test/no-snapshot",
      server: stubServer("@test/no-snapshot"),
    })

    let result: unknown = "sentinel"
    const clientModule = pkg.tui((ctx) => {
      result = ctx.getSnapshot()
      return {}
    })

    clientModule.setup(noopCtx)
    expect(result).toBeUndefined()
  })

  test("paired builtin IDs match their package IDs", () => {
    const pairedPackages = [
      AutoPackage,
      PlanPackage,
      TaskToolsPackage,
      HandoffPackage,
      InteractionToolsPackage,
    ]

    for (const pkg of pairedPackages) {
      const clientModule = pkg.tui(() => ({}))
      expect(clientModule.id).toBe(pkg.id)
    }
  })

  test("all paired builtins derive ID from package (no manual id)", () => {
    // Verify actual builtin modules match their package IDs
    const expectedIds = new Map([
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
    return {
      commands: [{
        id: "test-composer-state",
        title: "Test",
        onSelect: () => { getState() },
      }],
    }
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
        setup: {
          autocompleteItems: [
            {
              prefix: "#",
              title: "Tags",
              items: () => [{ id: "tag1", label: "tag1" }],
            },
          ],
        },
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
        setup: {
          autocompleteItems: [{ prefix: "$", title: "Skills A", items: () => [] }],
        },
      } satisfies LoadedTuiExtension,
      {
        id: "@test/b",
        kind: "user",
        filePath: "/test/b",
        setup: {
          autocompleteItems: [{ prefix: "$", title: "Skills B", items: () => [] }],
        },
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

    const prefixes = new Set(resolved.autocompleteItems.map((c) => c.prefix))
    expect(prefixes.has("$")).toBe(true)
    expect(prefixes.has("@")).toBe(true)
    expect(prefixes.has("/")).toBe(true)
  })
})
