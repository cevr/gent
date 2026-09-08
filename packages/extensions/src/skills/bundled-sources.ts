// oxlint-disable-next-line typescript/triple-slash-reference -- Downstream source consumers need this ambient Bun text-asset declaration without a runtime import.
/// <reference path="./markdown.d.ts" />
import acknowledgeBeforeProcessing from "./bundled/principles/references/acknowledge-before-processing.md" with { type: "text" }
import boundaryDiscipline from "./bundled/principles/references/boundary-discipline.md" with { type: "text" }
import chaseYNotX from "./bundled/principles/references/chase-y-not-x.md" with { type: "text" }
import compositionOverFlags from "./bundled/principles/references/composition-over-flags.md" with { type: "text" }
import correctnessOverPragmatism from "./bundled/principles/references/correctness-over-pragmatism.md" with { type: "text" }
import costAwareDelegation from "./bundled/principles/references/cost-aware-delegation.md" with { type: "text" }
import deriveDontSync from "./bundled/principles/references/derive-dont-sync.md" with { type: "text" }
import encodeLessonsInStructure from "./bundled/principles/references/encode-lessons-in-structure.md" with { type: "text" }
import exhaustTheDesignSpace from "./bundled/principles/references/exhaust-the-design-space.md" with { type: "text" }
import experienceFirst from "./bundled/principles/references/experience-first.md" with { type: "text" }
import fixRootCauses from "./bundled/principles/references/fix-root-causes.md" with { type: "text" }
import foundationalThinking from "./bundled/principles/references/foundational-thinking.md" with { type: "text" }
import guardTheContextWindow from "./bundled/principles/references/guard-the-context-window.md" with { type: "text" }
import makeImpossibleStatesUnrepresentable from "./bundled/principles/references/make-impossible-states-unrepresentable.md" with { type: "text" }
import makeOperationsIdempotent from "./bundled/principles/references/make-operations-idempotent.md" with { type: "text" }
import migrateCallersThenDeleteLegacyApis from "./bundled/principles/references/migrate-callers-then-delete-legacy-apis.md" with { type: "text" }
import nameEventsNotSetters from "./bundled/principles/references/name-events-not-setters.md" with { type: "text" }
import neverBlockOnTheHuman from "./bundled/principles/references/never-block-on-the-human.md" with { type: "text" }
import outcomeOrientedExecution from "./bundled/principles/references/outcome-oriented-execution.md" with { type: "text" }
import progressiveDisclosure from "./bundled/principles/references/progressive-disclosure.md" with { type: "text" }
import proveItWorks from "./bundled/principles/references/prove-it-works.md" with { type: "text" }
import redesignFromFirstPrinciples from "./bundled/principles/references/redesign-from-first-principles.md" with { type: "text" }
import serializeSharedStateMutations from "./bundled/principles/references/serialize-shared-state-mutations.md" with { type: "text" }
import smallInterfaceDeepImplementation from "./bundled/principles/references/small-interface-deep-implementation.md" with { type: "text" }
import subtractBeforeYouAdd from "./bundled/principles/references/subtract-before-you-add.md" with { type: "text" }
import testThroughPublicInterfaces from "./bundled/principles/references/test-through-public-interfaces.md" with { type: "text" }
import useThePlatform from "./bundled/principles/references/use-the-platform.md" with { type: "text" }
import principlesSkill from "./bundled/principles/SKILL.md" with { type: "text" }

import repositories from "./bundled/repositories/SKILL.md" with { type: "text" }

export const bundledSkillFiles: ReadonlyArray<readonly [string, string]> = [
  ["repositories/SKILL.md", repositories],
  ["principles/SKILL.md", principlesSkill],
  ["principles/references/acknowledge-before-processing.md", acknowledgeBeforeProcessing],
  ["principles/references/boundary-discipline.md", boundaryDiscipline],
  ["principles/references/chase-y-not-x.md", chaseYNotX],
  ["principles/references/composition-over-flags.md", compositionOverFlags],
  ["principles/references/correctness-over-pragmatism.md", correctnessOverPragmatism],
  ["principles/references/cost-aware-delegation.md", costAwareDelegation],
  ["principles/references/derive-dont-sync.md", deriveDontSync],
  ["principles/references/encode-lessons-in-structure.md", encodeLessonsInStructure],
  ["principles/references/exhaust-the-design-space.md", exhaustTheDesignSpace],
  ["principles/references/experience-first.md", experienceFirst],
  ["principles/references/fix-root-causes.md", fixRootCauses],
  ["principles/references/foundational-thinking.md", foundationalThinking],
  ["principles/references/guard-the-context-window.md", guardTheContextWindow],
  [
    "principles/references/make-impossible-states-unrepresentable.md",
    makeImpossibleStatesUnrepresentable,
  ],
  ["principles/references/make-operations-idempotent.md", makeOperationsIdempotent],
  [
    "principles/references/migrate-callers-then-delete-legacy-apis.md",
    migrateCallersThenDeleteLegacyApis,
  ],
  ["principles/references/name-events-not-setters.md", nameEventsNotSetters],
  ["principles/references/never-block-on-the-human.md", neverBlockOnTheHuman],
  ["principles/references/outcome-oriented-execution.md", outcomeOrientedExecution],
  ["principles/references/progressive-disclosure.md", progressiveDisclosure],
  ["principles/references/prove-it-works.md", proveItWorks],
  ["principles/references/redesign-from-first-principles.md", redesignFromFirstPrinciples],
  ["principles/references/serialize-shared-state-mutations.md", serializeSharedStateMutations],
  [
    "principles/references/small-interface-deep-implementation.md",
    smallInterfaceDeepImplementation,
  ],
  ["principles/references/subtract-before-you-add.md", subtractBeforeYouAdd],
  ["principles/references/test-through-public-interfaces.md", testThroughPublicInterfaces],
  ["principles/references/use-the-platform.md", useThePlatform],
]
