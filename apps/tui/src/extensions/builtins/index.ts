import type { ExtensionClientModule } from "@gent/core/domain/extension-client.js"

import builtinArtifacts from "./artifacts.client"
import builtinAuto from "./auto.client"
import builtinConnection from "./connection.client"
import builtinFiles from "./files.client"
import builtinHandoff from "./handoff.client"
import builtinInteractions from "./interactions.client"
import builtinPlan from "./plan.client"
import builtinSkills from "./skills.client"
import builtinTasks from "./tasks.client"
import builtinTools from "./tools.client"

export const builtinClientModules: ReadonlyArray<ExtensionClientModule> = [
  builtinArtifacts,
  builtinAuto,
  builtinConnection,
  builtinFiles,
  builtinHandoff,
  builtinInteractions,
  builtinPlan,
  builtinSkills,
  builtinTasks,
  builtinTools,
]
