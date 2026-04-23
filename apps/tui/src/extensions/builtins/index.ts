import type { AnyExtensionClientModule } from "../client-facets.js"

import builtinArtifacts from "./artifacts.client"
import builtinAuto from "./auto.client"
import builtinConnection from "./connection.client"
import builtinDriver from "./driver.client"
import builtinFiles from "./files.client"
import builtinHandoff from "./handoff.client"
import builtinInteractions from "./interactions.client"
import builtinPlan from "./plan.client"
import builtinSkills from "./skills.client"
import builtinTasks from "./tasks.client"
import builtinTools from "./tools.client"

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
  builtinPlan,
  builtinSkills,
  builtinTasks,
  builtinTools,
]
