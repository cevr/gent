/**
 * Integration tests for the TUI extension system.
 *
 * Tests the full pipeline: discovery → import → resolve, including
 * real file loading from temporary directories.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol.js"
import { loadTuiExtensions } from "../src/extensions/loader"
import { applyExtensionSnapshot } from "../src/extensions/context"
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"
import type { ExtensionClientContext } from "@gent/core/domain/extension-client.js"
import { SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"

const TEST_DIR = join(import.meta.dir, ".tmp-ext-integration")
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")
// Static builtin imports — same as context.tsx
import builtinTools from "../src/extensions/builtins/tools.client"
import builtinPlan from "../src/extensions/builtins/plan.client"
import builtinAuto from "../src/extensions/builtins/auto.client"
import builtinTasks from "../src/extensions/builtins/tasks.client"
import builtinConnection from "../src/extensions/builtins/connection.client"
import builtinInteractions from "../src/extensions/builtins/interactions.client"
import builtinHandoff from "../src/extensions/builtins/handoff.client"

const BUILTINS = [
  builtinTools,
  builtinPlan,
  builtinAuto,
  builtinTasks,
  builtinConnection,
  builtinInteractions,
  builtinHandoff,
]

const noopCtx: ExtensionClientContext = {
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
      { builtins: BUILTINS, userDir: emptyUser, projectDir: emptyProject },
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
    expect(resolved.renderers.has("librarian")).toBe(true)
    expect(resolved.renderers.has("finder")).toBe(true)
    expect(resolved.renderers.has("counsel")).toBe(true)
    expect(resolved.renderers.has("code_review")).toBe(true)
    expect(resolved.renderers.has("search_sessions")).toBe(true)
    expect(resolved.renderers.has("read_session")).toBe(true)

    rmSync(emptyUser, { recursive: true, force: true })
    rmSync(emptyProject, { recursive: true, force: true })
  })

  test("loads user extension with tool renderer", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: BUILTINS, userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    expect(resolved.renderers.has("my_custom_tool")).toBe(true)
  })

  test("loads user extension with widget", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: BUILTINS, userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    const widget = resolved.widgets.find((w) => w.id === "test-widget")
    expect(widget).toBeDefined()
    expect(widget?.slot).toBe("below-messages")
    expect(widget?.priority).toBe(50)
  })

  test("loads user extension with command", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: BUILTINS, userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    const cmd = resolved.commands.find((c) => c.id === "test-cmd")
    expect(cmd).toBeDefined()
    expect(cmd?.title).toBe("Test Command")
    expect(cmd?.category).toBe("test")
  })

  test("loads user extension with overlay", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: BUILTINS, userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    expect(resolved.overlays.has("test-overlay")).toBe(true)
  })

  test("project extension overrides builtin tool renderer", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: BUILTINS, userDir: join(TEST_DIR, "no-user"), projectDir: PROJECT_DIR },
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
      { builtins: BUILTINS, userDir: userBashDir, projectDir: PROJECT_DIR },
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
      { builtins: BUILTINS, userDir: ctxDir, projectDir: join(TEST_DIR, "no-project") },
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
      `import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { SharedProtocol } from "./shared-protocol"

export default defineClientExtension({
  id: "@test/shared-client",
  protocol: SharedProtocol,
  setup: (ctx) => ({
    commands: [
      {
        id: "shared.ping",
        title: "Shared Ping",
        onSelect: () => ctx.send(SharedProtocol.Ping({ value: "pong" })),
      },
    ],
  }),
})`,
    )

    const { ctx, sent } = createProtocolRecordingCtx()
    const resolved = await loadTuiExtensions(
      { builtins: BUILTINS, userDir: protocolDir, projectDir: join(TEST_DIR, "no-project") },
      ctx,
    )

    const command = resolved.commands.find((entry) => entry.id === "shared.ping")
    expect(command).toBeDefined()
    command!.onSelect()
    expect(sent).toEqual([{ extensionId: "@test/shared", _tag: "Ping", value: "pong" }])

    rmSync(protocolDir, { recursive: true, force: true })
  })

  test("nonexistent directories are handled gracefully", async () => {
    const resolved = await loadTuiExtensions(
      { builtins: BUILTINS, userDir: "/nonexistent/a", projectDir: "/nonexistent/b" },
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
      { builtins: BUILTINS, userDir: badDir, projectDir: join(TEST_DIR, "no-project") },
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
        builtins: BUILTINS,
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
        builtins: BUILTINS,
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
        builtins: BUILTINS,
        userDir: emptyUser,
        projectDir: emptyProject,
        disabled: ["@gent/plan", "@gent/tasks"],
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
          builtins: BUILTINS,
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
          builtins: BUILTINS,
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
          builtins: BUILTINS,
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
          builtins: BUILTINS,
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
          builtins: BUILTINS,
          userDir: collisionDir,
          projectDir: join(TEST_DIR, "no-project"),
        },
        noopCtx,
      ),
    ).rejects.toThrow("Same-scope TUI overlay collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })
})

describe("protocol resolution", () => {
  test("higher-scope protocol overrides merge by tag instead of dropping sibling tags", () => {
    const BaseProtocol = {
      Alpha: ExtensionMessage.reply("@test/shared", "Alpha", {}, Schema.String),
      Beta: ExtensionMessage.reply("@test/shared", "Beta", {}, Schema.String),
    }
    const OverrideProtocol = {
      Beta: ExtensionMessage.reply("@test/shared", "Beta", {}, Schema.Number),
    }

    const resolved = resolveTuiExtensions([
      {
        id: "@test/shared-builtin",
        kind: "builtin",
        filePath: "builtin:@test/shared-builtin",
        protocols: [BaseProtocol.Alpha, BaseProtocol.Beta],
        setup: {},
      } satisfies LoadedTuiExtension,
      {
        id: "@test/shared-project",
        kind: "project",
        filePath: "project:@test/shared-project",
        protocols: [OverrideProtocol.Beta],
        setup: {},
      } satisfies LoadedTuiExtension,
    ])

    const byTag = resolved.protocols.get("@test/shared")
    expect(byTag).toBeDefined()
    expect(byTag?.get("Alpha")).toBe(BaseProtocol.Alpha)
    expect(byTag?.get("Beta")).toBe(OverrideProtocol.Beta)
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
      { builtins: BUILTINS, userDir: composerDir, projectDir: join(TEST_DIR, "no-project") },
      customCtx,
    )

    const cmd = resolved.commands.find((c) => c.id === "test-composer-state")
    expect(cmd).toBeDefined()

    rmSync(composerDir, { recursive: true, force: true })
  })
})
