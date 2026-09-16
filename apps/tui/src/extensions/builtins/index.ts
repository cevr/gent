import type { AnyExtensionClientModule } from "../client-facets.js"

import { Effect } from "effect"
import { ref } from "@gent/core/extensions/api"
import { SkillsRpc } from "@gent/extensions/client.js"
import builtinAgentsView from "./agents-view.client"
import builtinBtw from "./btw.client"
import builtinDriver from "./driver.client"
import builtinFiles from "./files.client"
import builtinHerdr from "./herdr.client"
import builtinGoal from "./goal.client"
import builtinWake from "./wake.client"
import builtinThreadView from "./thread-view.client"
import { builtinInteractions, builtinTools } from "./tool-renderers.client"
import {
  defineClientExtension,
  autocompleteContribution,
  clientContributions,
  interactionRendererContribution,
  widgetContribution,
} from "../client-facets.js"
import { ClientTransport } from "../client-transport"
import { HandoffRenderer } from "../../components/interaction-renderers/handoff"
import { ConnectionWidget } from "../../components/connection-widget"
import { truncate } from "../../utils/truncate"
import { rankAutocompleteItems } from "../../components/autocomplete-ranking"

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
      // Skills were filtered by a plain substring test and left in whatever
      // order the host returned them, so `$te` answered with the first skill
      // whose name happened to contain those letters rather than the closest
      // one. Ranking puts the nearest name first, which is also the completion
      // the composer's ghost line offers.
      items: (filter: string) =>
        Effect.gen(function* () {
          const transport = yield* ClientTransport
          const skills = yield* transport.request(ref(SkillsRpc.ListSkills), {})
          return rankAutocompleteItems(
            skills.map((s) => ({
              id: s.name,
              label: s.name,
              description: truncate(s.description, 60),
            })),
            filter,
          )
        }),
      formatInsertion: (id: string) => `$${id.split(":").pop() ?? id} `,
    }),
  ),
})

// Builtins keep their precise `R` locally; the load membrane erases them in
// one place when `loader-boundary.ts` runs `runtime.runPromise(...)`.
export const builtinClientModules: ReadonlyArray<AnyExtensionClientModule> = [
  builtinAgentsView,
  builtinBtw,
  builtinConnection,
  builtinDriver,
  builtinFiles,
  builtinGoal,
  builtinWake,
  builtinHandoff,
  builtinHerdr,
  builtinInteractions,
  builtinSkills,
  builtinThreadView,
  builtinTools,
]
