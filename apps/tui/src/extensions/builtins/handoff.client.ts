import { Effect } from "effect"
import {
  defineClientExtension,
  clientContributions,
  interactionRendererContribution,
} from "../client-facets.js"
import { HandoffRenderer } from "../../components/interaction-renderers/handoff"

export default defineClientExtension("@gent/handoff", {
  setup: Effect.succeed(
    clientContributions(interactionRendererContribution(HandoffRenderer, "handoff")),
  ),
})
