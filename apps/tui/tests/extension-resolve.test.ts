import { describe, test, expect } from "bun:test"
import type { ExtensionClientSetup } from "@gent/core/domain/extension-client.js"
import { resolveTuiExtensions, type LoadedTuiExtension } from "../src/extensions/resolve"

type MockComponent = () => string

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  setup: ExtensionClientSetup<MockComponent>,
): LoadedTuiExtension => ({
  id,
  kind,
  filePath: kind === "builtin" ? "builtin" : `/test/${id}`,
  setup,
})

describe("resolveTuiExtensions", () => {
  describe("tool renderers", () => {
    test("resolves builtins", () => {
      const ext = makeExt("builtins", "builtin", {
        tools: [{ toolNames: ["read"], component: () => "read-builtin" }],
      })
      const { renderers } = resolveTuiExtensions([ext])
      expect(renderers.get("read")!()).toBe("read-builtin")
    })

    test("user overrides builtin", () => {
      const builtin = makeExt("builtins", "builtin", {
        tools: [{ toolNames: ["read"], component: () => "read-builtin" }],
      })
      const user = makeExt("custom", "user", {
        tools: [{ toolNames: ["read"], component: () => "read-custom" }],
      })
      const { renderers } = resolveTuiExtensions([builtin, user])
      expect(renderers.get("read")!()).toBe("read-custom")
    })

    test("project overrides user", () => {
      const user = makeExt("user-ext", "user", {
        tools: [{ toolNames: ["bash"], component: () => "bash-user" }],
      })
      const project = makeExt("proj-ext", "project", {
        tools: [{ toolNames: ["bash"], component: () => "bash-project" }],
      })
      const { renderers } = resolveTuiExtensions([user, project])
      expect(renderers.get("bash")!()).toBe("bash-project")
    })

    test("project overrides builtin", () => {
      const builtin = makeExt("builtins", "builtin", {
        tools: [{ toolNames: ["read"], component: () => "read-builtin" }],
      })
      const project = makeExt("proj", "project", {
        tools: [{ toolNames: ["read"], component: () => "read-project" }],
      })
      const { renderers } = resolveTuiExtensions([builtin, project])
      expect(renderers.get("read")!()).toBe("read-project")
    })

    test("same-scope collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "ext-a",
        kind: "user",
        filePath: "/test/ext-a",
        setup: { tools: [{ toolNames: ["read"], component: () => "a" }] },
      }
      const ext2: LoadedTuiExtension = {
        id: "ext-b",
        kind: "user",
        filePath: "/test/ext-b",
        setup: { tools: [{ toolNames: ["read"], component: () => "b" }] },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow("Same-scope TUI renderer collision")
    })

    test("tool names are lowercased", () => {
      const ext = makeExt("builtins", "builtin", {
        tools: [{ toolNames: ["WebFetch"], component: () => "wf" }],
      })
      const { renderers } = resolveTuiExtensions([ext])
      expect(renderers.get("webfetch")).toBeDefined()
    })

    test("multi-name tools register all names", () => {
      const ext = makeExt("builtins", "builtin", {
        tools: [{ toolNames: ["delegate", "librarian"], component: () => "del" }],
      })
      const { renderers } = resolveTuiExtensions([ext])
      expect(renderers.get("delegate")!()).toBe("del")
      expect(renderers.get("librarian")!()).toBe("del")
    })
  })

  describe("widgets", () => {
    test("resolves widgets sorted by priority", () => {
      const ext = makeExt("builtins", "builtin", {
        widgets: [
          { id: "queue", slot: "below-messages", priority: 30, component: () => "q" },
          { id: "task", slot: "below-messages", priority: 10, component: () => "t" },
          { id: "conn", slot: "below-messages", priority: 20, component: () => "c" },
        ],
      })
      const { widgets } = resolveTuiExtensions([ext])
      expect(widgets.map((w) => w.id)).toEqual(["task", "conn", "queue"])
    })

    test("default priority is 100", () => {
      const ext = makeExt("ext", "user", {
        widgets: [
          { id: "low", slot: "below-messages", priority: 10, component: () => "l" },
          { id: "default", slot: "below-messages", component: () => "d" },
        ],
      })
      const { widgets } = resolveTuiExtensions([ext])
      expect(widgets[0]!.id).toBe("low")
      expect(widgets[1]!.priority).toBe(100)
    })

    test("project widget overrides user widget", () => {
      const user = makeExt("user-ext", "user", {
        widgets: [{ id: "status", slot: "above-input", component: () => "user-status" }],
      })
      const project = makeExt("proj-ext", "project", {
        widgets: [{ id: "status", slot: "below-messages", component: () => "proj-status" }],
      })
      const { widgets } = resolveTuiExtensions([user, project])
      expect(widgets.length).toBe(1)
      expect(widgets[0]!.component()).toBe("proj-status")
    })

    test("same-scope widget collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "a",
        kind: "user",
        filePath: "/test/a",
        setup: { widgets: [{ id: "w", slot: "below-messages", component: () => "a" }] },
      }
      const ext2: LoadedTuiExtension = {
        id: "b",
        kind: "user",
        filePath: "/test/b",
        setup: { widgets: [{ id: "w", slot: "below-messages", component: () => "b" }] },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow("Same-scope TUI widget collision")
    })
  })

  describe("commands", () => {
    test("resolves commands", () => {
      const ext = makeExt("ext", "user", {
        commands: [{ id: "cmd1", title: "Test", onSelect: () => {} }],
      })
      const { commands } = resolveTuiExtensions([ext])
      expect(commands.length).toBe(1)
      expect(commands[0]!.id).toBe("cmd1")
    })

    test("same-scope command id collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "a",
        kind: "user",
        filePath: "/test/a",
        setup: { commands: [{ id: "cmd", title: "A", onSelect: () => {} }] },
      }
      const ext2: LoadedTuiExtension = {
        id: "b",
        kind: "user",
        filePath: "/test/b",
        setup: { commands: [{ id: "cmd", title: "B", onSelect: () => {} }] },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow("Same-scope TUI command collision")
    })

    test("same-scope keybind collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "a",
        kind: "user",
        filePath: "/test/a",
        setup: { commands: [{ id: "cmd-a", title: "A", keybind: "ctrl+k", onSelect: () => {} }] },
      }
      const ext2: LoadedTuiExtension = {
        id: "b",
        kind: "user",
        filePath: "/test/b",
        setup: { commands: [{ id: "cmd-b", title: "B", keybind: "ctrl+k", onSelect: () => {} }] },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow("Same-scope TUI keybind collision")
    })

    test("higher scope wins keybind, lower scope loses it", () => {
      const user = makeExt("user", "user", {
        commands: [{ id: "cmd-u", title: "U", keybind: "ctrl+k", onSelect: () => {} }],
      })
      const project = makeExt("proj", "project", {
        commands: [{ id: "cmd-p", title: "P", keybind: "ctrl+k", onSelect: () => {} }],
      })
      const { commands } = resolveTuiExtensions([user, project])
      expect(commands.length).toBe(2) // Both commands exist
      const userCmd = commands.find((c) => c.id === "cmd-u")!
      const projectCmd = commands.find((c) => c.id === "cmd-p")!
      expect(userCmd.keybind).toBeUndefined() // User lost the keybind
      expect(projectCmd.keybind).toBe("ctrl+k") // Project won it
    })
  })

  describe("overlays", () => {
    test("resolves overlays", () => {
      const ext = makeExt("ext", "user", {
        overlays: [{ id: "panel", component: () => "panel" }],
      })
      const { overlays } = resolveTuiExtensions([ext])
      expect(overlays.get("panel")!()).toBe("panel")
    })

    test("same-scope overlay collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "a",
        kind: "user",
        filePath: "/test/a",
        setup: { overlays: [{ id: "panel", component: () => "a" }] },
      }
      const ext2: LoadedTuiExtension = {
        id: "b",
        kind: "user",
        filePath: "/test/b",
        setup: { overlays: [{ id: "panel", component: () => "b" }] },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow("Same-scope TUI overlay collision")
    })
  })

  describe("empty", () => {
    test("empty input returns empty results", () => {
      const { renderers, widgets, commands, overlays } = resolveTuiExtensions([])
      expect(renderers.size).toBe(0)
      expect(widgets.length).toBe(0)
      expect(commands.length).toBe(0)
      expect(overlays.size).toBe(0)
    })
  })
})
