import type { AnyExtensionClientModule } from "../client-facets.js"

import { Clock, Effect, Option } from "effect"
import type { FileSystem, Path } from "effect"
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
import { ClientWorkspace } from "../client-services"
import { HandoffRenderer } from "../../interaction-renderers"
import { ConnectionWidget } from "../../components/connection-widget"
import { truncate } from "../../utils"
import {
  emptyFrecencyStore,
  frecencyLookup,
  rankAutocompleteItems,
  readFrecencyStore,
  recordFrecencyPick,
} from "../../autocomplete"

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
  setup: Effect.gen(function* () {
    const workspace = yield* ClientWorkspace
    // The store's reads and writes need `FileSystem` and `Path`. `onSelect`
    // is a plain sync callback from the composer with no Effect context of
    // its own, so the setup captures the services once and forks the write
    // against them.
    const storeServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const forkStoreWrite = Effect.runForkWith(storeServices)
    return autocompleteContribution({
      prefix: "$",
      title: "Skills",
      // Skills were filtered by a plain substring test and left in whatever
      // order the host returned them, so `$te` answered with the first skill
      // whose name happened to contain those letters rather than the closest
      // one. Ranking puts the nearest name first, which is also the completion
      // the composer's ghost line offers.
      // The store is read from disk per request rather than from the shared
      // in-memory snapshot. This runs in an extension setup's Effect, which
      // may await, and the file is a few KB opened on a keystroke, so the read
      // is cheap and picks written by another `gent` process are seen too.
      items: (filter: string) =>
        Effect.gen(function* () {
          const transport = yield* ClientTransport
          const skills = yield* transport.request(ref(SkillsRpc.ListSkills), {})
          const store = yield* readFrecencyStore(workspace.home)
          const lookup = frecencyLookup(
            Option.getOrElse(store, () => emptyFrecencyStore()),
            yield* Clock.currentTimeMillis,
          )
          return rankAutocompleteItems(
            skills.map((s) => ({
              id: s.name,
              label: s.name,
              description: truncate(s.description, 60),
            })),
            filter,
            { prefix: "$", frecency: lookup },
          )
        }),
      formatInsertion: (id: string) => `$${id.split(":").pop() ?? id} `,
      // Recording happens here rather than at the composer seam for `$`
      // alone, because the skills popup is the only surface that knows a
      // chosen row was a skill. The write itself belongs to the store, which
      // folds the pick into what is on disk under one gate — the `/` registry
      // records through the same function. Two writers with two strategies is
      // exactly what used to lose picks.
      onSelect: (id: string) => {
        forkStoreWrite(
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            recordFrecencyPick(workspace.home, "$", id, now),
          ),
        )
      },
    })
  }),
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
