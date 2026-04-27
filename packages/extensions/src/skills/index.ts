/**
 * @gent/skills extension — exposes user/project skills (`.md` files
 * under `~/.claude/skills/` and `<cwd>/.claude/skills/`) to agents.
 *
 * The store is a Behavior actor (W10-1d) spawned in `Resource.start`,
 * where the resource layer's `Skills` service is in scope and can be
 * captured into the actor's receive closure. The behavior reaches the
 * bucket boundary with no remaining service requirements; service
 * access flows entirely through the captured closure.
 */

import { Effect, Layer } from "effect"
import {
  defineExtension,
  defineResource,
  ProjectionError,
  ActorEngine,
  type ProjectionContribution,
} from "@gent/core/extensions/api"
import { Skills, formatSkillsForPrompt, type Skill } from "./skills.js"
import { SkillsTool } from "./skills-tool.js"
import { SearchSkillsTool } from "./search-skills.js"
import { SkillsProtocol } from "./protocol.js"
import { makeSkillsBehavior, SkillsService_Key } from "./actor.js"

// ── Projection (dynamic prompt section) ──

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
  resources: ({ ctx }) => [
    defineResource({
      tag: Skills,
      scope: "process",
      layer: Skills.Live({ cwd: ctx.cwd, home: ctx.home }).pipe(Layer.orDie),
      // Spawn the actor in `start` so the captured `Skills` and
      // `ActorEngine` are both in scope. The actor's `R` is `never`
      // at the bucket boundary; service access flows through the
      // closure baked at spawn time. `StartR = ActorEngine` declares
      // the additional service `start` may yield beyond the layer's
      // own R.
      start: Effect.gen(function* () {
        const skills = yield* Skills
        const engine = yield* ActorEngine
        yield* engine.spawn(makeSkillsBehavior(skills))
      }),
    }),
  ],
  protocols: SkillsProtocol,
  // The actor is spawned in `Resource.start` (not the static `actors:`
  // bucket), so the route collector points at the serviceKey directly.
  actorRoute: SkillsService_Key,
  tools: [SkillsTool, SearchSkillsTool],
  projections: [SkillsProjection],
})
