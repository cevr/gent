/**
 * Skills actor — Behavior over a closure-captured `Skills` service.
 *
 * The actor surface is service-free: the `Skills` service is captured
 * at extension start time (where the resource layer has it available)
 * and threaded into receive via closure. This lets the behavior reach
 * the bucket boundary as `Behavior<M, S, never>` without forcing the
 * actor host to learn about per-extension service deps.
 *
 * State is `{}` — there is no internal projection-worthy data. Every
 * reply is derived by calling the captured `skills.list()` / `get()`.
 *
 * `_tag` strings on `SkillsMsg.*` match `SkillsProtocol.*` so the
 * actor-route fallback in MachineEngine forwards extension RPC calls
 * straight into the actor mailbox.
 */

import { Effect, Schema } from "effect"
import { ServiceKey, TaggedEnumClass, type Behavior } from "@gent/core/extensions/api"
import type { SkillsService } from "./skills.js"

// ── Messages ──

export const SkillsMsg = TaggedEnumClass("SkillsMsg", {
  ListSkills: {},
  GetSkillContent: { name: Schema.String },
})
export type SkillsMsg = Schema.Schema.Type<typeof SkillsMsg>

export const SkillsService_Key = ServiceKey<SkillsMsg>("@gent/skills/store")

interface SkillsState {}

// ── Behavior factory ──
//
// Returns a `Behavior<SkillsMsg, {}, never>`. `Skills` is closed at
// construction time — the resource layer yields the service in
// `start` and hands it here, so the actor's R is `never` at the
// bucket boundary while every reply still reads live data via the
// captured closure.

export const makeSkillsBehavior = (
  skills: SkillsService,
): Behavior<SkillsMsg, SkillsState, never> => ({
  initialState: {},
  serviceKey: SkillsService_Key,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "ListSkills": {
          const all = yield* skills.list()
          yield* ctx.reply(
            all.map((s) => ({
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
          const found = yield* skills.get(msg.name)
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
