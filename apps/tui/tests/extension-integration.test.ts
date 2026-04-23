/**
 * TUI extension integration contracts.
 *
 * Keep one end-to-end story per user-visible outcome:
 * discovery, override precedence, disabled gating, invalid-file tolerance,
 * overlay state, autocomplete visibility, and startup with an active session.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { loadTuiExtensions as _loadTuiExtensions } from "../src/extensions/loader-boundary"
import {
  makeClientComposerLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "../src/extensions/client-services"
import { makeClientTransportLayer } from "../src/extensions/client-transport"
import { SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"
import { builtinClientModules } from "../src/extensions/builtins/index"

const throwOnAccess = (label: string): never => {
  throw new Error(`unexpected transport call in pure load test: ${label}`)
}

const stubClient = new Proxy(
  {},
  {
    get: (_target, prop) =>
      new Proxy(
        {},
        {
          get: (_target2, method) => () =>
            throwOnAccess(`client.${String(prop)}.${String(method)}`),
        },
      ),
  },
) as Parameters<typeof makeClientTransportLayer>[0]["client"]

const stubRuntime = new Proxy(
  {},
  { get: (_target, method) => () => throwOnAccess(`runtime.${String(method)}`) },
) as Parameters<typeof makeClientTransportLayer>[0]["runtime"]

const testRuntime = ManagedRuntime.make(
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
      client: stubClient,
      runtime: stubRuntime,
      currentSession: () => undefined,
      onExtensionStateChanged: () => () => {},
    }),
    makeClientLifecycleLayer({ addCleanup: () => {} }),
  ),
)

const loadTuiExtensions = (
  opts: Omit<Parameters<typeof _loadTuiExtensions>[0], "runtime"> & {
    runtime?: Parameters<typeof _loadTuiExtensions>[0]["runtime"]
  },
): ReturnType<typeof _loadTuiExtensions> =>
  _loadTuiExtensions({ ...opts, runtime: opts.runtime ?? testRuntime })

const TEST_DIR = join(import.meta.dir, ".tmp-ext-integration")
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")

beforeAll(() => {
  mkdirSync(USER_DIR, { recursive: true })
  mkdirSync(PROJECT_DIR, { recursive: true })

  mkdirSync(join(USER_DIR, "custom-read"), { recursive: true })
  writeFileSync(
    join(USER_DIR, "custom-read", "index.ts"),
    `export default { manifest: { id: "custom-read" }, setup: () => [] }`,
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
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe("loadTuiExtensions", () => {
  test("loads builtin surfaces when no user or project extensions exist", async () => {
    const emptyUser = join(TEST_DIR, "empty-user")
    const emptyProject = join(TEST_DIR, "empty-project")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: emptyUser,
      projectDir: emptyProject,
    })

    expect(resolved.renderers.has("read")).toBe(true)
    expect(resolved.renderers.has("bash")).toBe(true)
    expect(resolved.commands.some((command) => command.id === "plan.create")).toBe(true)

    rmSync(emptyUser, { recursive: true, force: true })
    rmSync(emptyProject, { recursive: true, force: true })
  })

  test("user extensions can add visible renderer, widget, command, and overlay surfaces", async () => {
    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: USER_DIR,
      projectDir: join(TEST_DIR, "no-project"),
    })

    expect(resolved.renderers.has("my_custom_tool")).toBe(true)
    expect(resolved.widgets.some((widget) => widget.id === "test-widget")).toBe(true)
    expect(resolved.commands.some((command) => command.id === "test-cmd")).toBe(true)
    expect(resolved.overlays.has("test-overlay")).toBe(true)
  })

  test("discovery ignores hidden and test-only files but still loads prebuilt modules deterministically", async () => {
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
    expect(commandIds.filter((id) => id === "alpha" || id === "zeta")).toEqual(["alpha", "zeta"])
  })

  test("project scope overrides builtin and user tool renderers", async () => {
    const userOverrideDir = join(TEST_DIR, "user-bash")
    mkdirSync(userOverrideDir, { recursive: true })
    writeFileSync(
      join(userOverrideDir, "override.client.ts"),
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
      userDir: userOverrideDir,
      projectDir: PROJECT_DIR,
    })

    const bashRenderer = resolved.renderers.get("bash") as (() => string) | undefined
    expect(bashRenderer?.()).toBe("project-bash-override")

    rmSync(userOverrideDir, { recursive: true, force: true })
  })

  test("disabled extensions are removed before setup runs", async () => {
    const disabledDir = join(TEST_DIR, "disabled-user")
    mkdirSync(disabledDir, { recursive: true })
    writeFileSync(
      join(disabledDir, "bomb.client.ts"),
      `import { Effect } from "effect"
export default {
  id: "@test/bomb",
  setup: Effect.sync(() => { throw new Error("setup() should not be called for disabled extension") }),
}`,
    )

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: disabledDir,
      projectDir: join(TEST_DIR, "no-project"),
      disabled: ["@gent/tools", "@test/bomb"],
    })

    expect(resolved.renderers.has("read")).toBe(false)
    expect(resolved.renderers.has("bash")).toBe(false)
    expect(resolved.commands.some((command) => command.id === "plan.create")).toBe(true)

    rmSync(disabledDir, { recursive: true, force: true })
  })

  test("invalid extension files are skipped without breaking the builtin bundle", async () => {
    const badDir = join(TEST_DIR, "bad-ext")
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, "bad.client.ts"), "export default { not: 'an extension' }")

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: badDir,
      projectDir: join(TEST_DIR, "no-project"),
    })

    expect(resolved.renderers.has("read")).toBe(true)

    rmSync(badDir, { recursive: true, force: true })
  })

  test("same-scope collisions still fail through the public load path", async () => {
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

  test("builtin autocomplete sources stay visible", async () => {
    const emptyUser = join(TEST_DIR, "empty-user-ac")
    const emptyProject = join(TEST_DIR, "empty-project-ac")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    const resolved = await loadTuiExtensions({
      builtins: builtinClientModules,
      userDir: emptyUser,
      projectDir: emptyProject,
    })

    const prefixes = new Set(resolved.autocompleteItems.map((entry) => entry.prefix))
    expect(prefixes.has("$")).toBe(true)
    expect(prefixes.has("@")).toBe(true)

    rmSync(emptyUser, { recursive: true, force: true })
    rmSync(emptyProject, { recursive: true, force: true })
  })

  test("startup with an active session does not break transport-only widgets", async () => {
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
          client: {
            extension: {
              ask: () => Effect.void,
              request: () => Effect.void,
              listCommands: () => Effect.succeed([]),
            },
          } as Parameters<typeof makeClientTransportLayer>[0]["client"],
          runtime: {
            run: () => Promise.reject(new Error("no transport in test")),
          } as Parameters<typeof makeClientTransportLayer>[0]["runtime"],
          currentSession: () => ({
            sessionId: "test-session-id" as never,
            branchId: "test-branch-id" as never,
          }),
          onExtensionStateChanged: () => () => {},
        }),
        makeClientLifecycleLayer({ addCleanup: () => {} }),
      ),
    )

    const emptyUser = join(TEST_DIR, "active-session-user")
    const emptyProject = join(TEST_DIR, "active-session-project")
    mkdirSync(emptyUser, { recursive: true })
    mkdirSync(emptyProject, { recursive: true })

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const resolved = await loadTuiExtensions({
        builtins: builtinClientModules,
        userDir: emptyUser,
        projectDir: emptyProject,
        runtime: activeSessionRuntime,
      })

      const widgetIds = new Set(resolved.widgets.map((widget) => widget.id))
      const borderPositions = new Set(resolved.borderLabels.map((label) => label.position))

      expect(widgetIds.has("tasks")).toBe(true)
      expect(borderPositions.has("top-left")).toBe(true)
      expect(borderPositions.has("bottom-right")).toBe(true)
      expect(borderPositions.has("bottom-left")).toBe(true)
    } finally {
      console.warn = originalWarn
      rmSync(emptyUser, { recursive: true, force: true })
      rmSync(emptyProject, { recursive: true, force: true })
      await activeSessionRuntime.dispose()
    }
  })
})

describe("session UI state", () => {
  test("extension overlays replace the current overlay and close cleanly", () => {
    const withMermaid = transitionSessionUi(SessionUiState.initial(), { _tag: "OpenMermaid" })
    const withExtension = transitionSessionUi(withMermaid.state, {
      _tag: "OpenExtensionOverlay",
      overlayId: "my-ext:panel",
    })
    const closed = transitionSessionUi(withExtension.state, { _tag: "CloseOverlay" })

    expect(withExtension.state.overlay).toEqual({
      _tag: "extension",
      overlayId: "my-ext:panel",
    })
    expect(closed.state.overlay).toEqual({ _tag: "none" })
  })
})
