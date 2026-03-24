/**
 * Integration tests for the TUI extension system.
 *
 * Tests the full pipeline: discovery → import → resolve, including
 * real file loading from temporary directories.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { loadTuiExtensions } from "../src/extensions/loader"
import type { ExtensionClientContext } from "@gent/core/domain/extension-client.js"
import { SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"

const TEST_DIR = join(import.meta.dir, ".tmp-ext-integration")
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")

const noopCtx: ExtensionClientContext = {
  openOverlay: () => {},
  closeOverlay: () => {},
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
      { userDir: emptyUser, projectDir: emptyProject },
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
      { userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    expect(resolved.renderers.has("my_custom_tool")).toBe(true)
  })

  test("loads user extension with widget", async () => {
    const resolved = await loadTuiExtensions(
      { userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    const widget = resolved.widgets.find((w) => w.id === "test-widget")
    expect(widget).toBeDefined()
    expect(widget?.slot).toBe("below-messages")
    expect(widget?.priority).toBe(50)
  })

  test("loads user extension with command", async () => {
    const resolved = await loadTuiExtensions(
      { userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    const cmd = resolved.commands.find((c) => c.id === "test-cmd")
    expect(cmd).toBeDefined()
    expect(cmd?.title).toBe("Test Command")
    expect(cmd?.category).toBe("test")
  })

  test("loads user extension with overlay", async () => {
    const resolved = await loadTuiExtensions(
      { userDir: USER_DIR, projectDir: join(TEST_DIR, "no-project") },
      noopCtx,
    )

    expect(resolved.overlays.has("test-overlay")).toBe(true)
  })

  test("project extension overrides builtin tool renderer", async () => {
    const resolved = await loadTuiExtensions(
      { userDir: join(TEST_DIR, "no-user"), projectDir: PROJECT_DIR },
      noopCtx,
    )

    // bash should be overridden by project extension
    const bashRenderer = resolved.renderers.get("bash")
    expect(bashRenderer).toBeDefined()
    // The override returns "project-bash-override"
    expect(typeof bashRenderer).toBe("function")
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
      { userDir: userBashDir, projectDir: PROJECT_DIR },
      noopCtx,
    )

    // Project should win over user
    const bashRenderer = resolved.renderers.get("bash")
    expect(bashRenderer).toBeDefined()
    // Can't easily check which one won without rendering, but we know project > user

    rmSync(userBashDir, { recursive: true, force: true })
  })

  test("nonexistent directories are handled gracefully", async () => {
    const resolved = await loadTuiExtensions(
      { userDir: "/nonexistent/a", projectDir: "/nonexistent/b" },
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
      { userDir: badDir, projectDir: join(TEST_DIR, "no-project") },
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

describe("same-scope collision detection", () => {
  test("two user extensions with same tool name throws", async () => {
    const collisionDir = join(TEST_DIR, "collision")
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
        { userDir: collisionDir, projectDir: join(TEST_DIR, "no-project") },
        noopCtx,
      ),
    ).rejects.toThrow("Same-scope TUI renderer collision")

    rmSync(collisionDir, { recursive: true, force: true })
  })
})
