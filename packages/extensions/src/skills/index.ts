import { Effect, Layer, Schema } from "effect"
import { Machine, State as MState, Event as MEvent, Slot } from "effect-machine"
import {
  defineExtension,
  defineResource,
  projectionContribution,
  ProjectionError,
  toolContribution,
  type ProjectionContribution,
  type ResourceMachine,
} from "@gent/core/extensions/api"
import { Skills, formatSkillsForPrompt, type Skill } from "./skills.js"
import { SkillsTool } from "./skills-tool.js"
import { SearchSkillsTool } from "./search-skills.js"
import { SkillsProtocol, SkillEntry } from "./protocol.js"

// ── Machine for extension protocol ──

const SkillsMachineState = MState({
  Active: { initialized: Schema.Boolean },
})

const SkillsMachineEvent = MEvent({
  ListSkills: MEvent.reply({}, Schema.Array(SkillEntry)),
  GetSkillContent: MEvent.reply({ name: Schema.String }, Schema.NullOr(SkillEntry)),
})

const SkillsMachineSlots = Slot.define({
  listSkills: Slot.fn({}, Schema.Array(SkillEntry)),
  getSkill: Slot.fn({ name: Schema.String }, Schema.NullOr(SkillEntry)),
})

const skillsMachine = Machine.make({
  state: SkillsMachineState,
  event: SkillsMachineEvent,
  slots: SkillsMachineSlots,
  initial: SkillsMachineState.Active({ initialized: true }),
})
  .on(SkillsMachineState.Active, SkillsMachineEvent.ListSkills, ({ state, slots }) =>
    Effect.gen(function* () {
      const entries = yield* slots.listSkills()
      return Machine.reply(state, entries)
    }),
  )
  .on(SkillsMachineState.Active, SkillsMachineEvent.GetSkillContent, ({ state, event, slots }) =>
    Effect.gen(function* () {
      const entry = yield* slots.getSkill({ name: event.name })
      return Machine.reply(state, entry)
    }),
  )

const skillsActor: ResourceMachine<
  typeof SkillsMachineState.Type,
  typeof SkillsMachineEvent.Type,
  Skills,
  typeof SkillsMachineSlots.definitions
> = {
  machine: skillsMachine,
  slots: () =>
    Effect.gen(function* () {
      const skills = yield* Skills
      return {
        listSkills: () =>
          skills.list().pipe(
            Effect.map((all) =>
              all.map((s) => ({
                name: s.name,
                description: s.description,
                level: s.level,
                filePath: s.filePath,
                content: s.content,
              })),
            ),
          ),
        getSkill: ({ name }) =>
          skills.get(name).pipe(
            Effect.map((s) =>
              s !== undefined
                ? {
                    name: s.name,
                    description: s.description,
                    level: s.level,
                    filePath: s.filePath,
                    content: s.content,
                  }
                : null,
            ),
          ),
      }
    }),
  mapRequest: (message) => {
    if (SkillsProtocol.ListSkills.is(message)) return SkillsMachineEvent.ListSkills
    if (SkillsProtocol.GetSkillContent.is(message))
      return SkillsMachineEvent.GetSkillContent(message)
  },
  protocols: SkillsProtocol,
}

// ── Projection (dynamic prompt section, was promptSectionContribution.resolve) ──

const SkillsProjection: ProjectionContribution<ReadonlyArray<Skill>, Skills> = {
  id: "skills",
  query: () =>
    Effect.gen(function* () {
      const skills = yield* Skills
      return yield* skills
        .list()
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(new ProjectionError({ projectionId: "skills", reason: String(e) })),
          ),
        )
    }),
  prompt: (allSkills) => [
    { id: "skills", priority: 80, content: formatSkillsForPrompt(allSkills) },
  ],
}

// ── Extension ──

export const SkillsExtension = defineExtension({
  id: "@gent/skills",
  contributions: ({ ctx }) => [
    // Single Resource carries the Skills service layer AND the skills
    // machine. Per the C3.5 "Resource = layer + machine" merge.
    defineResource({
      tag: Skills,
      scope: "process",
      layer: Skills.Live({ cwd: ctx.cwd, home: ctx.home }).pipe(Layer.orDie),
      machine: skillsActor,
    }),
    toolContribution(SkillsTool),
    toolContribution(SearchSkillsTool),
    projectionContribution(SkillsProjection),
  ],
})
