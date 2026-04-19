import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { autocompleteContribution } from "@gent/core/domain/extension-client.js"
import { Effect } from "effect"
import { SkillsProtocol } from "@gent/extensions/skills/protocol"
import { askExtension } from "../client-transport"

// C9.2: items() returns an Effect — `ClientTransport` is yielded transitively
// via `askExtension`, which mirrors the legacy `ctx.ask(message)` semantics
// (auto-fill sessionId/branchId from the active session, decode the reply
// against the registered protocol). The popup adapter runs the Effect through
// `extensionUI.clientRuntime.runPromise`. Setup itself stays legacy
// (sync (ctx) => array); the C9.3 sweep promotes setup to Effect-typed too.
export default ExtensionPackage.tui("@gent/skills-ui", () => [
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
])
