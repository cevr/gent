import { captureTurnTools } from "@gent/core/test-utils"
import { GentPlatform } from "@gent/core/host"
import { testAgent } from "../../core/tests/helpers/test-preset"
import { CellTool } from "../src/cell.js"

export const values = [captureTurnTools, GentPlatform, testAgent, CellTool]
