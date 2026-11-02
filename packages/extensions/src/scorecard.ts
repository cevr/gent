/**
 * The role scorecard: how each model and effort did in each role of the
 * orchestrate machines, read from the runs' stored steps and nothing a
 * scored model wrote about itself. A round counts by the engine's record; a
 * finding counts by the judgment of someone other than its writer
 * (`Judged`); an escape by what a later check, gate or answer did.
 *
 * Owner-facing only: `gent ctl review` reads it through the machines
 * extension's review request (`MachinesRpc.Roles`). No prompt, ask, round
 * message or tool result reads it, so a model never sees how it is
 * measured: `machines.ts` imports this module only in its review section,
 * and a guard (`findScorecardImportFindings`) fails any other import.
 */
import { Option, Order, Predicate, Schema } from "effect"
import type { MachineDefinition, MachineStep } from "./machines.js"

/**
 * One measure of a role's model: `Count` a number of things, `Ratio` a
 * number per `n` things. A ratio over fewer than `MIN_N` holds no value:
 * the review prints `—` and its `n`.
 */
const RoleMeasure = Schema.TaggedUnion({
  Count: { name: Schema.String, n: Schema.Int },
  Ratio: { name: Schema.String, n: Schema.Int, value: Schema.optionalKey(Schema.Finite) },
})
type RoleMeasure = typeof RoleMeasure.Type

/** One role's measures for one model and effort, a line of `roles.jsonl`. */
export const RoleScore = Schema.Struct({
  role: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  measures: Schema.Array(RoleMeasure),
})
export type RoleScore = typeof RoleScore.Type

/** One run as the scorecard reads it: its definition and its steps, oldest first. */
interface RoleRun {
  readonly definition: MachineDefinition
  readonly steps: ReadonlyArray<MachineStep>
}

/** The fewest things a ratio counts before it holds a value. */
const MIN_N = 5

/** The orchestrate machines' words: each role's thread, and the verdicts and answers that judge. */
const PLANNER = "planner"
const IMPLEMENTOR = "implementor"
const REVIEWER = "reviewer"
const VERIFIER = "verifier"
const ROLE_ORDER = [PLANNER, IMPLEMENTOR, REVIEWER, VERIFIER]
const PASSING_REVIEWS = new Set(["accepted", "proven"])
const RED_ANSWERS = new Set(["fix", "changes"])
/** How a merge gate moves when the work did not pass it: a check's `fail`, an integrate's `red`. */
const RED_GATES = new Set(["fail", "red"])
const CLASSES = ["defect", "test-strength", "spec", "environment", "unclassified"] as const

/** A model and effort, as a round's record and end name them. */
interface Label {
  readonly model: Option.Option<string>
  readonly effort: Option.Option<string>
}

const labelKey = (role: string, label: Label) =>
  [role, Option.getOrElse(label.model, () => ""), Option.getOrElse(label.effort, () => "")].join(
    "\u0000",
  )

/**
 * The gates of a definition: each run state that is not a screen, and each
 * integrate state. A red one (`fail`, `red`) is a merge gate the work did
 * not pass.
 */
const gatesOf = (definition: MachineDefinition): ReadonlySet<string> =>
  new Set(
    Object.entries(definition.states)
      .filter(
        ([, state]) =>
          (state.kind === "run" && state.screen !== true) || state.kind === "integrate",
      )
      .map(([name]) => name),
  )

/** What one step says of the passing review and the passing verify before it. */
interface Escapes {
  readonly review: boolean
  readonly verify: boolean
}

const NO_ESCAPE: Escapes = { review: false, verify: false }

/**
 * The escape rule, named once: what a step says of the passing review and
 * the passing verify before it. A failed verify, a red merge gate, or an
 * answer that sends the work back (`fix`, `changes`) after a review that
 * accepted it is an escape of that review (its reviewer, and the
 * implementor whose round it judged). A red merge gate after a verify that
 * passed is an escape of that verify (its verifier).
 */
const escapesAt = (step: MachineStep, gates: ReadonlySet<string>): Escapes => {
  if (step._tag === "RoundEnded" && step.role === VERIFIER && step.verdict === "fail")
    return { review: true, verify: false }
  if (step._tag === "Moved" && gates.has(step.from) && RED_GATES.has(step.by))
    return { review: true, verify: true }
  if (step._tag === "Answered" && RED_ANSWERS.has(step.choice))
    return { review: true, verify: false }
  return NO_ESCAPE
}

/** A role's model and effort, as one counter's owner. */
interface Owner {
  readonly role: string
  readonly label: Label
}

/** Counters by role, model and effort. */
class Tally {
  readonly owners = new Map<string, Owner>()
  readonly counts = new Map<string, Map<string, number>>()

  add(owner: Owner, counter: string, amount = 1) {
    const key = labelKey(owner.role, owner.label)
    this.owners.set(key, owner)
    const counts = this.counts.get(key) ?? new Map<string, number>()
    counts.set(counter, (counts.get(counter) ?? 0) + amount)
    this.counts.set(key, counts)
  }
}

type RoundEnded = Extract<MachineStep, { readonly _tag: "RoundEnded" }>
type FindingRecord = Extract<MachineStep, { readonly _tag: "Findings" }>["findings"][number]

/** An implementor's spend on one run: its cost, priced while every round was. */
interface Spend {
  readonly owner: Owner
  readonly cost: number
  readonly priced: boolean
}

/** A passing review: its reviewer, and the implementor whose round it judged. */
interface PassingReview {
  readonly reviewer: Owner
  readonly implementor: Owner
}

/** One run's fold into the tally, step by step. */
class RunFold {
  private readonly records = new Map<string, Label>()
  private readonly findings = new Map<
    string,
    { readonly finding: FindingRecord; readonly writer: Owner }
  >()
  private readonly statuses = new Map<string, string>()
  private readonly worked = new Set<string>()
  private readonly spends = new Map<string, Spend>()
  private lastRound = Option.none<Owner>()
  private plan = Option.none<Owner>()
  private firstImplementor = Option.none<Owner>()
  private lastImplementor = Option.none<Owner>()
  private implementorRounds = 0
  private reviews = 0
  private accepted = false
  private passingReview = Option.none<PassingReview>()
  private passingVerify = Option.none<Owner>()

  constructor(
    private readonly tally: Tally,
    private readonly gates: ReadonlySet<string>,
  ) {}

  step(step: MachineStep) {
    this.escapes(escapesAt(step, this.gates))
    switch (step._tag) {
      case "Recorded":
        if (step.action._tag === "Round" && Predicate.isNotUndefined(step.action.round))
          this.records.set(step.action.round, {
            model: Option.fromUndefinedOr(step.action.model),
            effort: Option.fromUndefinedOr(step.action.effort),
          })
        return
      case "RoundEnded":
        return this.roundEnded(step)
      case "Findings":
        for (const writer of Option.toArray(this.lastRound))
          for (const finding of step.findings)
            this.findings.set(`r${finding.round} ${finding.id}`, { finding, writer })
        return
      case "Judged":
        this.statuses.set(step.key, step.status)
        return
      case "Moved":
        if (step.by === "oversize") this.toPlan("size-stops")
        return
      case "Answered":
        if (step.choice === "rewrite") this.toPlan("rewrites")
        return
      case "Finished":
        if (step.accepted !== false) this.merged()
        return
      default:
        return
    }
  }

  /** Every finding someone other than its writer judged, counted to its writer. */
  end() {
    for (const [key, { finding, writer }] of this.findings) {
      const status = this.statuses.get(key)
      if (status === "rejected") this.tally.add(writer, "rejected")
      if (status !== "confirmed") continue
      if (finding.severity === "fail") this.tally.add(writer, "confirmed-fails")
      if (finding.severity === "blocker" || finding.severity === "major")
        this.tally.add(writer, `confirmed-${finding.class}`)
    }
  }

  private escapes(escapes: Escapes) {
    if (escapes.review) {
      for (const review of Option.toArray(this.passingReview)) {
        this.tally.add(review.reviewer, "escapes")
        this.tally.add(review.implementor, "escapes")
      }
      this.passingReview = Option.none()
    }
    if (escapes.verify) {
      for (const verifier of Option.toArray(this.passingVerify)) this.tally.add(verifier, "escapes")
      this.passingVerify = Option.none()
    }
  }

  private toPlan(counter: string) {
    for (const planner of Option.toArray(this.plan)) this.tally.add(planner, counter)
  }

  private roundEnded(step: RoundEnded) {
    if (step.dead || Predicate.isUndefined(step.role)) return
    const recorded = Option.fromUndefinedOr(this.records.get(step.round))
    const owner: Owner = {
      role: step.role,
      label: {
        model: Option.orElse(Option.fromUndefinedOr(step.model), () =>
          Option.flatMap(recorded, (found) => found.model),
        ),
        effort: Option.flatMap(recorded, (found) => found.effort),
      },
    }
    this.lastRound = Option.some(owner)
    this.tally.add(owner, "rounds")
    const key = labelKey(owner.role, owner.label)
    if (!this.worked.has(key)) {
      this.worked.add(key)
      this.tally.add(owner, "units")
    }
    if (owner.role === PLANNER) this.planned(owner)
    if (owner.role === IMPLEMENTOR) this.implemented(owner, step)
    if (owner.role === REVIEWER) this.reviewed(owner, PASSING_REVIEWS.has(step.verdict ?? ""))
    if (owner.role === VERIFIER && step.verdict === "pass") {
      this.tally.add(owner, "passes")
      this.passingVerify = Option.some(owner)
    }
  }

  /** A plan after the run's first is a replan of the plan before it. */
  private planned(owner: Owner) {
    if (Option.isSome(this.plan)) this.toPlan("replans")
    this.plan = Option.some(owner)
  }

  private implemented(owner: Owner, step: RoundEnded) {
    this.implementorRounds += 1
    if (Option.isNone(this.firstImplementor)) this.firstImplementor = Option.some(owner)
    this.lastImplementor = Option.some(owner)
    this.passingReview = Option.none()
    this.passingVerify = Option.none()
    const key = labelKey(owner.role, owner.label)
    const spent = this.spends.get(key) ?? { owner, cost: 0, priced: true }
    this.spends.set(key, {
      owner,
      cost: spent.cost + (step.costUsd ?? 0),
      priced: spent.priced && Predicate.isNotUndefined(step.costUsd),
    })
  }

  /** The unit's first review judges its first implementor's round 1; its first pass, the rounds it took. */
  private reviewed(owner: Owner, passes: boolean) {
    this.reviews += 1
    for (const first of Option.toArray(this.firstImplementor)) {
      if (this.reviews === 1) {
        this.tally.add(first, "first-reviewed")
        if (passes) this.tally.add(first, "first-accepted")
      }
      if (passes && !this.accepted) {
        this.tally.add(first, "accepted-units")
        this.tally.add(first, "rounds-to-accept", this.implementorRounds)
      }
    }
    if (!passes) return
    this.accepted = true
    this.tally.add(owner, "accepted")
    this.passingReview = Option.map(this.lastImplementor, (implementor) => ({
      reviewer: owner,
      implementor,
    }))
  }

  private merged() {
    this.toPlan("merged")
    for (const spent of this.spends.values()) {
      this.tally.add(spent.owner, "merged-units")
      if (!spent.priced) continue
      this.tally.add(spent.owner, "priced-merged-units")
      this.tally.add(spent.owner, "merged-cost", spent.cost)
    }
  }
}

/** Adds one run's counters to `tally`. */
const tallyRun = (tally: Tally, run: RoleRun) => {
  const fold = new RunFold(tally, gatesOf(run.definition))
  for (const step of run.steps) fold.step(step)
  fold.end()
}

const count = (counts: ReadonlyMap<string, number>, name: string, counter: string) =>
  RoleMeasure.cases.Count.make({ name, n: counts.get(counter) ?? 0 })

/** `of` per `per`: no value under `MIN_N`. */
const ratio = (counts: ReadonlyMap<string, number>, name: string, of: string, per: string) => {
  const n = counts.get(per) ?? 0
  if (n < MIN_N) return RoleMeasure.cases.Ratio.make({ name, n })
  return RoleMeasure.cases.Ratio.make({ name, n, value: (counts.get(of) ?? 0) / n })
}

/** The measures of each role, from its counters. */
const measuresOf = (
  role: string,
  counts: ReadonlyMap<string, number>,
): ReadonlyArray<RoleMeasure> => {
  switch (role) {
    case PLANNER:
      return [
        count(counts, "plans", "rounds"),
        ratio(counts, "units-per-plan", "units", "rounds"),
        ratio(counts, "replans-per-plan", "replans", "rounds"),
        ratio(counts, "rewrites-per-plan", "rewrites", "rounds"),
        ratio(counts, "size-stops-per-plan", "size-stops", "rounds"),
        ratio(counts, "merged-units-per-plan", "merged", "rounds"),
      ]
    case IMPLEMENTOR:
      return [
        count(counts, "rounds", "rounds"),
        count(counts, "units", "units"),
        ratio(counts, "round-1-accepted", "first-accepted", "first-reviewed"),
        ratio(counts, "rounds-until-accepted", "rounds-to-accept", "accepted-units"),
        ratio(counts, "cost-per-merged-unit", "merged-cost", "priced-merged-units"),
        ratio(counts, "escapes-per-merged-unit", "escapes", "merged-units"),
      ]
    case REVIEWER:
      return [
        count(counts, "rounds", "rounds"),
        ...CLASSES.map((name) =>
          ratio(counts, `confirmed-${name}-per-round`, `confirmed-${name}`, "rounds"),
        ),
        ratio(counts, "rejected-per-round", "rejected", "rounds"),
        ratio(counts, "escapes-per-accepted-review", "escapes", "accepted"),
      ]
    case VERIFIER:
      return [
        count(counts, "verifies", "rounds"),
        count(counts, "confirmed-fails", "confirmed-fails"),
        ratio(counts, "escapes-per-pass", "escapes", "passes"),
      ]
    default:
      return [count(counts, "rounds", "rounds")]
  }
}

/**
 * The scorecard of `runs`: one line per role and model and effort, the four
 * roles first in their order, then any other thread role, each by model.
 */
export const scoreRoles = (runs: ReadonlyArray<RoleRun>): ReadonlyArray<RoleScore> => {
  const tally = new Tally()
  for (const run of runs) tallyRun(tally, run)
  const rank = (role: string) => {
    const at = ROLE_ORDER.indexOf(role)
    if (at === -1) return ROLE_ORDER.length
    return at
  }
  return Array.from(tally.owners, ([key, { role, label }]) => ({
    key,
    score: {
      role,
      ...Option.match(label.model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
      ...Option.match(label.effort, { onNone: () => ({}), onSome: (effort) => ({ effort }) }),
      measures: measuresOf(role, tally.counts.get(key) ?? new Map()),
    },
  }))
    .sort((a, b) => rank(a.score.role) - rank(b.score.role) || Order.String(a.key, b.key))
    .map(({ score }) => score)
}

/**
 * The words no model-facing text of a shipped machine says: a model is
 * never told it is scored, ranked or measured, nor what counts against it.
 */
const SCORE_WORDS =
  /\b(scores?|scored|scoring|scorecards?|ranks?|ranked|ranking|rates?|rated|escapes?|escaped|measured|measures?)\b/i

/** The score words `text` says, lowercase, in order. */
export const scoreWordsIn = (text: string): ReadonlyArray<string> =>
  Array.from(text.matchAll(new RegExp(SCORE_WORDS.source, "gi")), (match) =>
    (match[0] ?? "").toLowerCase(),
  )
