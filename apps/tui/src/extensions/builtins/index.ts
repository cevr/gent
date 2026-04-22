import type { ExtensionClientModule } from "../client-facets.js"

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

// Effect-typed setups widen `R` beyond `ClientDeps`: yielding TUI services
// (`ClientWorkspace`, `ClientTransport`, etc.) requires `R = those services`.
// The loader's runtime provides every TUI service; the `any` here is the
// dynamic boundary where each module's specific R union is erased and
// `runtime.runPromise` enforces dependency satisfaction at runtime.
export const builtinClientModules: ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ExtensionClientModule<unknown, any>
> = [
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
