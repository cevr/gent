import type { AnyExtensionClientModule } from "../client-facets.js"

import { Effect } from "effect"
import { ref } from "@gent/core/extensions/api"
import { SkillsRpc } from "@gent/extensions/client.js"
import builtinArtifacts from "./artifacts.client"
import builtinAuto from "./auto.client"
import builtinDriver from "./driver.client"
import builtinFiles from "./files.client"
import { builtinInteractions, builtinTodos, builtinTools } from "./tool-renderers.client"
import {
  defineClientExtension,
  autocompleteContribution,
  clientContributions,
  interactionRendererContribution,
  widgetContribution,
} from "../client-facets.js"
import { requestExtension } from "../client-transport"
import { HandoffRenderer } from "../../components/interaction-renderers/handoff"
import { ConnectionWidget } from "../../components/connection-widget"

const builtinConnection = defineClientExtension("@gent/connection", {
  setup: Effect.succeed(
    widgetContribution({
      id: "connection",
      slot: "below-messages",
      priority: 30,
      component: ConnectionWidget,
    }),
  ),
})

const builtinHandoff = defineClientExtension("@gent/handoff", {
  setup: Effect.succeed(
    clientContributions(interactionRendererContribution(HandoffRenderer, "handoff")),
  ),
})

const builtinSkills = defineClientExtension("@gent/skills-ui", {
  setup: Effect.succeed(
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
                s.description.length > 60 ? s.description.slice(0, 60) + "..." : s.description,
            }))
        }),
      formatInsertion: (id: string) => `$${id.split(":").pop() ?? id} `,
    }),
  ),
})

// Builtins keep their precise `R` locally; the load membrane erases them in
// one place when `loader-boundary.ts` runs `runtime.runPromise(...)`.
export const builtinClientModules: ReadonlyArray<AnyExtensionClientModule> = [
  builtinArtifacts,
  builtinAuto,
  builtinConnection,
  builtinDriver,
  builtinFiles,
  builtinHandoff,
  builtinInteractions,
  builtinSkills,
  builtinTodos,
  builtinTools,
]
