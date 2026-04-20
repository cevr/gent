import { ExtensionPackage, autocompleteContribution } from "@gent/core/domain/extension-client.js"
import { Effect } from "effect"
import { SkillsProtocol } from "@gent/extensions/skills/protocol"
import { askExtension } from "../client-transport"

// C9.3: Effect-typed setup. The setup itself takes no dependencies — the
// autocomplete `items` Effect yields `ClientTransport` transitively via
// `askExtension(message)`, which auto-fills sessionId/branchId from the
// active session and decodes the reply against the registered protocol.
// The popup adapter runs both the setup and the per-call `items` Effect
// through `extensionUI.clientRuntime.runPromise`.
export default ExtensionPackage.tui("@gent/skills-ui", {
  setup: Effect.succeed([
    autocompleteContribution({
      prefix: "$",
      title: "Skills",
      items: (filter: string) =>
        Effect.gen(function* () {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — askExtension returns `any` E to keep autocomplete-items ergonomic; the popup adapter normalizes failures to []
          const skills = yield* askExtension(SkillsProtocol.ListSkills())
          const lowerFilter = filter.toLowerCase()
          return skills
            .filter((s) => s.name.toLowerCase().includes(lowerFilter))
            .map((s) => ({
              id: s.name,
              label: s.name,
              description:
                s.description.length > 60 ? s.description.slice(0, 60) + "…" : s.description,
            }))
        }),
      formatInsertion: (id: string) => `$${id.split(":").pop() ?? id} `,
    }),
  ]),
})
