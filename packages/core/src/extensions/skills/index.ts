import { Effect, Layer, Path, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { Machine, State as MState, Event as MEvent, Slot } from "effect-machine"
import { extension } from "../api.js"
import { Skills, formatSkillsForPrompt } from "./skills.js"
import type { ExtensionActorDefinition } from "../../domain/extension.js"
import { SkillsTool } from "./skills-tool.js"
import { SearchSkillsTool } from "./search-skills.js"
import { SKILLS_EXTENSION_ID, SkillsProtocol, SkillEntry } from "./protocol.js"

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

const skillsActor: ExtensionActorDefinition<
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
    if (message.extensionId !== SKILLS_EXTENSION_ID) return undefined
    switch (message._tag) {
      case "ListSkills":
        return SkillsMachineEvent.ListSkills
      case "GetSkillContent": {
        const request = message as ReturnType<typeof SkillsProtocol.GetSkillContent>
        return SkillsMachineEvent.GetSkillContent(request)
      }
    }
  },
  protocols: SkillsProtocol,
}

// ── Extension ──

export const SkillsExtension = extension("@gent/skills", ({ ext, ctx }) =>
  ext
    .layer(
      Skills.Live({ cwd: ctx.cwd, home: ctx.home }).pipe(
        Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
        Layer.orDie,
      ),
    )
    .tools(SkillsTool, SearchSkillsTool)
    .actor(skillsActor)
    .promptSections({
      id: "skills",
      priority: 80,
      resolve: Effect.gen(function* () {
        const skills = yield* Skills
        const allSkills = yield* skills.list()
        return formatSkillsForPrompt(allSkills)
      }),
    }),
)
