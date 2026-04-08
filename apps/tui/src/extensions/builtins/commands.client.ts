import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import type { AutocompleteItem } from "@gent/core/domain/extension-client.js"

/** Session/chrome commands — always available, not feature-specific */
const SESSION_COMMANDS: ReadonlyArray<AutocompleteItem> = [
  { id: "clear", label: "/clear", description: "Clear messages" },
  { id: "new", label: "/new", description: "Start new session" },
  { id: "sessions", label: "/sessions", description: "Open sessions picker" },
  { id: "branch", label: "/branch", description: "Create new branch" },
  { id: "tree", label: "/tree", description: "Browse branch tree" },
  { id: "fork", label: "/fork", description: "Fork from a message" },
  { id: "think", label: "/think", description: "Set reasoning level" },
  { id: "permissions", label: "/permissions", description: "View/edit permission rules" },
  { id: "auth", label: "/auth", description: "Manage API keys" },
]

export default ExtensionPackage.tui("@gent/commands-ui", () => ({
  autocompleteItems: [
    {
      prefix: "/",
      title: "Commands",
      trigger: "start" as const,
      items: (filter: string) => {
        const lowerFilter = filter.toLowerCase()
        return SESSION_COMMANDS.filter(
          (c) => c.id.toLowerCase().includes(lowerFilter) || c.label.includes(lowerFilter),
        )
      },
    },
  ],
}))
