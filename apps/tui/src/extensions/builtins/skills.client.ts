import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { SkillsProtocol } from "@gent/core/extensions/skills/protocol"

export default ExtensionPackage.tui("@gent/skills-ui", (ctx) => ({
  autocompleteItems: [
    {
      prefix: "$",
      title: "Skills",
      trigger: "inline" as const,
      items: async (filter: string) => {
        const skills = await ctx.ask(SkillsProtocol.ListSkills())
        const lowerFilter = filter.toLowerCase()
        return skills
          .filter((s) => s.name.toLowerCase().includes(lowerFilter))
          .map((s) => ({
            id: s.name,
            label: s.name,
            description:
              s.description.length > 60 ? s.description.slice(0, 60) + "…" : s.description,
          }))
      },
      formatInsertion: (id: string) => `$${id.split(":").pop() ?? id} `,
    },
  ],
}))
