/**
 * Skills actor — Behavior over a closure-captured `Skills` service.
 *
 * The actor surface is service-free: the `Skills` service is captured
 * at extension start time (where the resource layer has it available)
 * and threaded into receive via closure. This lets the behavior reach
 * the bucket boundary as `Behavior<M, S, never>` without forcing the
 * actor host to learn about per-extension service deps.
 *
 * State is the loaded skill list. The Skills resource loads once at
 * process-scope start, so the actor owns the prompt/view and RPC surface
 * without a parallel prompt derivation path.
 *
 * `_tag` strings on `SkillsMsg.*` match `SkillsProtocol.*` so the
 * actor-route fallback in ActorRouter forwards extension RPC calls
 * straight into the actor mailbox.
 */

import { Effect, Schema } from "effect"
import { ServiceKey, TaggedEnumClass, type Behavior } from "@gent/core/extensions/api"
import { formatSkillsForPrompt, resolveSkillName, type Skill } from "./skills.js"

// ── Messages ──

export const SkillsMsg = TaggedEnumClass("SkillsMsg", {
  ListSkills: {},
  GetSkillContent: { name: Schema.String },
})
export type SkillsMsg = Schema.Schema.Type<typeof SkillsMsg>

export const SkillsService_Key = ServiceKey<SkillsMsg>("@gent/skills/store")

interface SkillsState {
  readonly skills: ReadonlyArray<Skill>
}

// ── Behavior factory ──
//
// Returns a `Behavior<SkillsMsg, {}, never>`. `Skills` is closed at
// construction time — the resource layer yields the service in
// `start` and hands it here, so the actor's R is `never` at the
// bucket boundary while every reply still reads live data via the
// captured closure.

export const makeSkillsBehavior = (
  initialSkills: ReadonlyArray<Skill>,
): Behavior<SkillsMsg, SkillsState, never> => ({
  initialState: { skills: initialSkills },
  serviceKey: SkillsService_Key,
  view: (state) => ({
    prompt: [{ id: "skills", priority: 80, content: formatSkillsForPrompt(state.skills) }],
  }),
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "ListSkills": {
          yield* ctx.reply(
            state.skills.map((s) => ({
              name: s.name,
              description: s.description,
              level: s.level,
              filePath: s.filePath,
              content: s.content,
            })),
          )
          return state
        }
        case "GetSkillContent": {
          const found = resolveSkillName(state.skills, msg.name)
          yield* ctx.reply(
            found !== undefined
              ? {
                  name: found.name,
                  description: found.description,
                  level: found.level,
                  filePath: found.filePath,
                  content: found.content,
                }
              : null,
          )
          return state
        }
      }
    }),
})
