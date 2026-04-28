import { defineClientExtension, autocompleteContribution } from "../client-facets.js"
import { Effect } from "effect"
import { ref } from "@gent/core/extensions/api"
import { SkillsRpc } from "@gent/extensions/skills/protocol"
import { requestExtension } from "../client-transport"

// C9.3: Effect-typed setup. The setup itself takes no dependencies — the
// autocomplete `items` Effect yields `ClientTransport` transitively via
// `requestExtension(ref, input)`, which auto-fills sessionId/branchId
// from the active session and decodes the reply against the request token.
// The popup adapter runs both the setup and the per-call `items` Effect
// through `extensionUI.clientRuntime.runPromise`.
export default defineClientExtension("@gent/skills-ui", {
  setup: Effect.succeed([
    autocompleteContribution({
      prefix: "$",
      title: "Skills",
      items: (filter: string) =>
        Effect.gen(function* () {
          const skills = yield* requestExtension(ref(SkillsRpc.ListSkills), {})
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
