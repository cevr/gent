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

    test("same-scope slash collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "a",
        kind: "user",
        filePath: "/test/a",
        setup: { commands: [{ id: "cmd-a", title: "A", slash: "foo", onSelect: () => {} }] },
      }
      const ext2: LoadedTuiExtension = {
        id: "b",
        kind: "user",
        filePath: "/test/b",
        setup: { commands: [{ id: "cmd-b", title: "B", slash: "foo", onSelect: () => {} }] },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow("Same-scope TUI slash collision")
    })

    test("higher scope wins slash, lower scope loses it", () => {
      const user = makeExt("user", "user", {
        commands: [{ id: "cmd-u", title: "U", slash: "deploy", onSelect: () => {} }],
      })
      const project = makeExt("proj", "project", {
        commands: [{ id: "cmd-p", title: "P", slash: "deploy", onSelect: () => {} }],
      })
      const { commands } = resolveTuiExtensions([user, project])
      expect(commands.length).toBe(2)
      const userCmd = commands.find((c) => c.id === "cmd-u")!
      const projectCmd = commands.find((c) => c.id === "cmd-p")!
      expect(userCmd.slash).toBeUndefined() // User lost the slash
      expect(projectCmd.slash).toBe("deploy") // Project won it
    })

    test("resolves command with slash field", () => {
      const ext = makeExt("ext", "user", {
        commands: [{ id: "cmd1", title: "Test", slash: "test", onSelect: () => {} }],
      })
      const { commands } = resolveTuiExtensions([ext])
      expect(commands[0]!.slash).toBe("test")
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

  describe("interaction renderers", () => {
    test("resolves by event tag", () => {
      const ext = makeExt("builtins", "builtin", {
        interactionRenderers: [
          { eventTag: "QuestionsAsked", component: () => "questions" },
          { eventTag: "PermissionRequested", component: () => "permission" },
        ],
      })
      const { interactionRenderers } = resolveTuiExtensions([ext])
      expect(interactionRenderers.get("QuestionsAsked")!()).toBe("questions")
      expect(interactionRenderers.get("PermissionRequested")!()).toBe("permission")
    })

    test("user overrides builtin for same tag", () => {
      const builtin = makeExt("builtins", "builtin", {
        interactionRenderers: [{ eventTag: "QuestionsAsked", component: () => "builtin-q" }],
      })
      const user = makeExt("custom", "user", {
        interactionRenderers: [{ eventTag: "QuestionsAsked", component: () => "user-q" }],
      })
      const { interactionRenderers } = resolveTuiExtensions([builtin, user])
      expect(interactionRenderers.get("QuestionsAsked")!()).toBe("user-q")
    })

    test("project overrides user for same tag", () => {
      const user = makeExt("user-ext", "user", {
        interactionRenderers: [{ eventTag: "PermissionRequested", component: () => "user-p" }],
      })
      const project = makeExt("proj-ext", "project", {
        interactionRenderers: [{ eventTag: "PermissionRequested", component: () => "proj-p" }],
      })
      const { interactionRenderers } = resolveTuiExtensions([user, project])
      expect(interactionRenderers.get("PermissionRequested")!()).toBe("proj-p")
    })

    test("same-scope collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "a",
        kind: "user",
        filePath: "/test/a",
        setup: {
          interactionRenderers: [{ eventTag: "QuestionsAsked", component: () => "a" }],
        },
      }
      const ext2: LoadedTuiExtension = {
        id: "b",
        kind: "user",
        filePath: "/test/b",
        setup: {
          interactionRenderers: [{ eventTag: "QuestionsAsked", component: () => "b" }],
        },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow(
        "Same-scope TUI interaction renderer collision",
      )
    })

    test("different tags from different extensions resolve independently", () => {
      const ext1 = makeExt("ext1", "builtin", {
        interactionRenderers: [{ eventTag: "QuestionsAsked", component: () => "q" }],
      })
      const ext2 = makeExt("ext2", "builtin", {
        interactionRenderers: [{ eventTag: "HandoffPresented", component: () => "h" }],
      })
      const { interactionRenderers } = resolveTuiExtensions([ext1, ext2])
      expect(interactionRenderers.size).toBe(2)
    })
  })

  describe("composer surface", () => {
    test("resolves single composer surface", () => {
      const ext = makeExt("ext", "user", {
        composerSurface: () => "custom-composer",
      })
      const { composerSurface } = resolveTuiExtensions([ext])
      expect(composerSurface!()).toBe("custom-composer")
    })

    test("higher scope wins", () => {
      const user = makeExt("user-ext", "user", {
        composerSurface: () => "user-composer",
      })
      const project = makeExt("proj-ext", "project", {
        composerSurface: () => "proj-composer",
      })
      const { composerSurface } = resolveTuiExtensions([user, project])
      expect(composerSurface!()).toBe("proj-composer")
    })

    test("same-scope collision throws", () => {
      const ext1: LoadedTuiExtension = {
        id: "a",
        kind: "user",
        filePath: "/test/a",
        setup: { composerSurface: () => "a" },
      }
      const ext2: LoadedTuiExtension = {
        id: "b",
        kind: "user",
        filePath: "/test/b",
        setup: { composerSurface: () => "b" },
      }
      expect(() => resolveTuiExtensions([ext1, ext2])).toThrow(
        "Same-scope TUI composer surface collision",
      )
    })

    test("undefined when no extension provides one", () => {
      const ext = makeExt("ext", "user", {
        tools: [{ toolNames: ["read"], component: () => "read" }],
      })
      const { composerSurface } = resolveTuiExtensions([ext])
      expect(composerSurface).toBeUndefined()
    })
  })

  describe("empty", () => {
    test("empty input returns empty results", () => {
      const { renderers, widgets, commands, overlays, interactionRenderers, composerSurface } =
        resolveTuiExtensions([])
      expect(renderers.size).toBe(0)
      expect(widgets.length).toBe(0)
      expect(commands.length).toBe(0)
      expect(overlays.size).toBe(0)
      expect(interactionRenderers.size).toBe(0)
      expect(composerSurface).toBeUndefined()
    })
  })
})
