/**
 * The role scorecard: how each model and effort did in each role of the
 * orchestrate machines (`ROLE_MACHINES`), read from the runs' stored steps
 * and nothing a scored model wrote about itself. A round counts by the
 * engine's record; a finding by the engine's own ledger (`ledgerAfter`) and
 * the judgment of someone other than its writer (`Judged`); an escape by
 * what a later check, gate or answer did.
 *
 * Owner-facing only: `gent ctl review` reads it through the machines
 * extension's review request (`MachinesRpc.Roles`). No prompt, ask, round
 * message or tool result reads it, so a model never sees how it is
 * measured: `machines.ts` imports this module only in its review section,
 * and a guard (`findScorecardReaders`) fails any other import.
 *
 * It imports the ledger fold and the measure schema back from
 * `machines.ts`, which imports it: neither module uses the other while it
 * loads, only inside functions.
 */
import { Option, Order, Predicate } from "effect"
import {
  type FindingLedger,
  ledgerAfter,
  type MachineDefinition,
  type MachineStep,
  RoleMeasure,
  type RoleScore,
} from "./machines.js"

/** One run as the scorecard reads it: its definition and its steps, oldest first. */
interface RoleRun {
  readonly definition: MachineDefinition
  readonly steps: ReadonlyArray<MachineStep>
}

/** The fewest things a ratio counts before it holds a value. */
const MIN_N = 5

/**
 * The machines whose threads are the orchestrate roles: the shipped
 * orchestrate machines, by name. Another machine's `reviewer` thread is not
 * this role, so its runs count nothing.
 */
const ROLE_MACHINES = new Set(["orchestrate", "orchestrate-light"])

/** The orchestrate machines' words: each role's thread, and the states, verdicts and answers that judge. */
const PLANNER = "planner"
const IMPLEMENTOR = "implementor"
const REVIEWER = "reviewer"
const VERIFIER = "verifier"
const ROLE_ORDER = [PLANNER, IMPLEMENTOR, REVIEWER, VERIFIER]
/** The implementor state after a blocked answer, a red gate or a red push: its rounds count nothing. */
const RESUME = "resume"
/** How a merge moves when a person declined its PR: the answer after it is no escape. */
const DECLINED = "declined"
const PASSING_REVIEWS = new Set(["accepted", "proven"])
const RED_ANSWERS = new Set(["fix", "changes"])
/** How a merge gate moves when the work did not pass it: a check's `fail`, an integrate's `red`. */
const RED_GATES = new Set(["fail", "red"])
const CLASSES = ["defect", "test-strength", "spec", "environment", "unclassified"] as const
type LedgerEntry = FindingLedger extends ReadonlyMap<string, infer Entry> ? Entry : never

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

/** What the escape rule reads of the run before a step. */
interface EscapeContext {
  readonly gates: ReadonlySet<string>
  /** The states whose last command timed out. */
  readonly timedOut: ReadonlySet<string>
  /** How the run last moved. */
  readonly lastMove: Option.Option<string>
}

/**
 * The escape rule, named once: what a step says of the passing review and
 * the passing verify before it. A failed verify, a red merge gate, or an
 * answer that sends the work back (`fix`, `changes`) after a review that
 * accepted it is an escape of that review (its reviewer, and the
 * implementor whose round it judged). A red merge gate after a verify that
 * passed is an escape of that verify (its verifier). A gate that timed out
 * is the environment's, and an answer to a declined PR a person's call:
 * neither is an escape.
 */
const escapesAt = (step: MachineStep, context: EscapeContext): Escapes => {
  if (step._tag === "RoundEnded" && step.role === VERIFIER && step.verdict === "fail")
    return { review: true, verify: false }
  if (
    step._tag === "Moved" &&
    context.gates.has(step.from) &&
    RED_GATES.has(step.by) &&
    !context.timedOut.has(step.from)
  )
    return { review: true, verify: true }
  if (
    step._tag === "Answered" &&
    RED_ANSWERS.has(step.choice) &&
    !Option.contains(context.lastMove, DECLINED)
  )
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
type FixesStep = Extract<MachineStep, { readonly _tag: "Fixes" }>
type FindingsStep = Extract<MachineStep, { readonly _tag: "Findings" }>

/** An implementor's spend on one run: the cost of its priced rounds, of all its rounds. */
interface Spend {
  readonly owner: Owner
  readonly cost: number
  readonly rounds: number
  readonly priced: number
}

/** A passing review: its reviewer, and the implementor whose round it judged. */
interface PassingReview {
  readonly reviewer: Owner
  readonly implementor: Owner
}

/** The unit's accept, counted at the run's end unless an escape undid it. */
interface Accept {
  readonly implementor: Owner
  readonly rounds: number
  readonly first: boolean
}

const isBlocking = (entry: LedgerEntry) =>
  entry.finding.severity === "blocker" || entry.finding.severity === "major"

/** One run's fold into the tally, step by step. */
class RunFold {
  private readonly records = new Map<string, Label>()
  private ledger: FindingLedger = new Map()
  private readonly writers = new Map<string, Owner>()
  private readonly fixers = new Map<string, Owner>()
  private readonly holds = new Map<number, ReadonlySet<string>>()
  private readonly worked = new Set<string>()
  private readonly reviewed = new Set<string>()
  private readonly spends = new Map<string, Spend>()
  private readonly timedOut = new Set<string>()
  private lastMove = Option.none<string>()
  private lastRound = Option.none<Owner>()
  private plan = Option.none<Owner>()
  private lastImplementor = Option.none<Owner>()
  private implementorRounds = 0
  private reviews = 0
  private accept = Option.none<Accept>()
  private passingReview = Option.none<PassingReview>()
  private passingVerify = Option.none<Owner>()

  constructor(
    private readonly tally: Tally,
    private readonly gates: ReadonlySet<string>,
  ) {}

  step(step: MachineStep) {
    this.escapes(
      escapesAt(step, { gates: this.gates, timedOut: this.timedOut, lastMove: this.lastMove }),
    )
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
      case "CommandEnded":
        if (step.timedOut) this.timedOut.add(step.state)
        else this.timedOut.delete(step.state)
        return
      case "Findings":
        return this.findings(step)
      case "Fixes":
        return this.fixes(step)
      case "Judged":
        this.ledger = ledgerAfter(this.ledger, step)
        return
      case "Moved":
        this.lastMove = Option.some(step.by)
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

  /**
   * The unit's accept, unless an escape undid it, counted to the implementor
   * whose round it accepted; then every finding someone other than its
   * writer judged, counted to its writer.
   */
  end() {
    for (const accept of Option.toArray(this.accept)) {
      this.tally.add(accept.implementor, "accepted-units")
      this.tally.add(accept.implementor, "rounds-to-accept", accept.rounds)
      if (accept.first) this.tally.add(accept.implementor, "first-accepted")
    }
    for (const [key, entry] of this.ledger) {
      const writer = this.writers.get(key)
      if (Predicate.isNotUndefined(writer)) this.judgedFinding(writer, entry)
    }
  }

  /** A finding's judgment, counted to its writer. */
  private judgedFinding(writer: Owner, entry: LedgerEntry) {
    if (entry.status === "open") return
    const fail = entry.finding.severity === "fail"
    if (entry.status === "withdrawn") this.tally.add(writer, "withdrawn")
    if (entry.status === "rejected" && fail) this.tally.add(writer, "rejected-fails")
    if (entry.status === "rejected" && !fail) this.tally.add(writer, "rejected")
    if (entry.status !== "confirmed") return
    if (fail) this.tally.add(writer, "confirmed-fails")
    if (!isBlocking(entry)) return
    this.tally.add(writer, `confirmed-${entry.finding.class}`)
    for (const by of Option.toArray(entry.by)) this.tally.add(writer, `confirmed-by-${by}`)
  }

  /**
   * A review's or verify's findings: each new key is its writer's; each hold
   * of a fixed key refutes its fixer; each key a `Still holds` line names is
   * one for the next request to answer.
   */
  private findings(step: FindingsStep) {
    this.holds.set(
      step.round,
      new Set([...(this.holds.get(step.round) ?? []), ...(step.held ?? [])]),
    )
    const before = this.ledger
    this.ledger = ledgerAfter(before, step)
    for (const [key, entry] of this.ledger) {
      const was = before.get(key)
      if (Predicate.isUndefined(was))
        for (const writer of Option.toArray(this.lastRound)) this.writers.set(key, writer)
      const refuted = entry.refuted - (was?.refuted ?? 0)
      const fixer = this.fixers.get(key)
      if (refuted > 0 && Predicate.isNotUndefined(fixer)) this.tally.add(fixer, "refuted", refuted)
    }
  }

  /**
   * A request's answer: each key it marks fixed is a fix claim of its
   * implementor; each Blocker, Major or failed verify of the round before
   * it, and each key that round still holds, is one to answer, unanswered
   * when the request neither fixed nor disputed it.
   */
  private fixes(step: FixesStep) {
    for (const implementor of Option.toArray(this.lastRound)) {
      for (const key of step.fixed) {
        if (!this.ledger.has(key)) continue
        this.tally.add(implementor, "fix-claims")
        this.fixers.set(key, implementor)
      }
      const answered = new Set([...step.fixed, ...step.disputed.map(({ key }) => key)])
      const toAnswer = new Set(this.holds.get(step.round - 1))
      for (const [key, entry] of this.ledger) {
        if (entry.finding.round !== step.round - 1) continue
        if (isBlocking(entry) || entry.finding.severity === "fail") toAnswer.add(key)
      }
      for (const key of toAnswer) {
        this.tally.add(implementor, "to-answer")
        if (!answered.has(key)) this.tally.add(implementor, "unanswered")
      }
    }
    this.ledger = ledgerAfter(this.ledger, step)
  }

  private escapes(escapes: Escapes) {
    if (escapes.review) {
      for (const review of Option.toArray(this.passingReview)) {
        this.tally.add(review.reviewer, "escapes")
        this.tally.add(review.implementor, "escapes")
        this.accept = Option.none()
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
    if (owner.role === REVIEWER) this.reviewedBy(owner, step)
    if (owner.role === VERIFIER && step.verdict === "pass") this.passingVerify = Option.some(owner)
  }

  /** A plan after the run's first is a replan of the plan before it. */
  private planned(owner: Owner) {
    if (Option.isSome(this.plan)) this.toPlan("replans")
    this.plan = Option.some(owner)
  }

  /** An implementor round: a resume counts no round toward the accept. */
  private implemented(owner: Owner, step: RoundEnded) {
    if (step.state !== RESUME) this.implementorRounds += 1
    this.lastImplementor = Option.some(owner)
    this.passingReview = Option.none()
    this.passingVerify = Option.none()
    const key = labelKey(owner.role, owner.label)
    const spent = this.spends.get(key) ?? { owner, cost: 0, rounds: 0, priced: 0 }
    const priced = Predicate.isNotUndefined(step.costUsd)
    this.spends.set(key, {
      owner,
      cost: spent.cost + (step.costUsd ?? 0),
      rounds: spent.rounds + 1,
      priced: spent.priced + Number(priced),
    })
  }

  /**
   * A review: the unit's first judges its implementor's round 1, each counts
   * its implementor's unit as reviewed once, and the first that passes is
   * the unit's accept, of the implementor whose round it judged.
   */
  private reviewedBy(owner: Owner, step: RoundEnded) {
    this.reviews += 1
    if (step.verdict === "changes") this.tally.add(owner, "changes")
    const passes = PASSING_REVIEWS.has(step.verdict ?? "")
    for (const implementor of Option.toArray(this.lastImplementor)) {
      if (this.reviews === 1) this.tally.add(implementor, "first-reviewed")
      const key = labelKey(implementor.role, implementor.label)
      if (!this.reviewed.has(key)) {
        this.reviewed.add(key)
        this.tally.add(implementor, "reviewed-units")
      }
      if (!passes) continue
      this.passingReview = Option.some({ reviewer: owner, implementor })
      if (Option.isNone(this.accept))
        this.accept = Option.some({
          implementor,
          rounds: this.implementorRounds,
          first: this.reviews === 1,
        })
    }
  }

  private merged() {
    this.toPlan("merged")
    for (const spent of this.spends.values()) {
      this.tally.add(spent.owner, "merged-units")
      this.tally.add(spent.owner, "merged-cost", spent.cost)
      this.tally.add(spent.owner, "cost-rounds", spent.rounds)
      this.tally.add(spent.owner, "priced-rounds", spent.priced)
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

/** How many `of` of `per`. */
const share = (counts: ReadonlyMap<string, number>, name: string, of: string, per: string) =>
  RoleMeasure.cases.Share.make({ name, of: counts.get(of) ?? 0, n: counts.get(per) ?? 0 })

/** The measures of each role, from its counters. */
const measuresOf = (
  role: string,
  counts: ReadonlyMap<string, number>,
): ReadonlyArray<RoleMeasure> => {
  switch (role) {
    case PLANNER:
      return [
        count(counts, "plans", "rounds"),
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
        ratio(counts, "cost-per-merged-unit", "merged-cost", "merged-units"),
        share(counts, "priced", "priced-rounds", "cost-rounds"),
        ratio(counts, "escapes-per-reviewed-unit", "escapes", "reviewed-units"),
        ratio(counts, "fix-claims-refuted", "refuted", "fix-claims"),
        ratio(counts, "findings-left-unanswered", "unanswered", "to-answer"),
      ]
    case REVIEWER:
      return [
        count(counts, "rounds", "rounds"),
        count(counts, "units", "units"),
        ratio(counts, "rounds-per-unit", "rounds", "units"),
        ratio(counts, "changes-per-unit", "changes", "units"),
        ...CLASSES.map((name) =>
          ratio(counts, `confirmed-${name}-per-round`, `confirmed-${name}`, "rounds"),
        ),
        ratio(counts, "confirmed-by-repeat-test-per-round", "confirmed-by-repeat-test", "rounds"),
        ratio(counts, "confirmed-by-fix-per-round", "confirmed-by-fixed", "rounds"),
        ratio(counts, "confirmed-by-answer-per-round", "confirmed-by-answer", "rounds"),
        ratio(counts, "rejected-per-round", "rejected", "rounds"),
        ratio(counts, "withdrawn-per-round", "withdrawn", "rounds"),
        ratio(counts, "escapes-per-unit", "escapes", "units"),
      ]
    case VERIFIER:
      return [
        count(counts, "verifies", "rounds"),
        count(counts, "units", "units"),
        count(counts, "confirmed-fails", "confirmed-fails"),
        ratio(counts, "rejected-fails-per-verify", "rejected-fails", "rounds"),
        ratio(counts, "escapes-per-unit", "escapes", "units"),
      ]
    default:
      return [count(counts, "rounds", "rounds")]
  }
}

/**
 * The scorecard of `runs`: one line per role and model and effort, the four
 * roles first in their order, then any other thread role, each by model.
 * Only the runs of `ROLE_MACHINES` count.
 */
export const scoreRoles = (runs: ReadonlyArray<RoleRun>): ReadonlyArray<RoleScore> => {
  const tally = new Tally()
  for (const run of runs) if (ROLE_MACHINES.has(run.definition.name)) tallyRun(tally, run)
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
  /\b(scores?|scored|scoring|scorecards?|ranks?|ranked|ranking|rates?|rated|escapes?|escaped|measured|measures?|metrics?|performance|grades?|graded|rewards?|evaluate|evaluation|accuracy|percent|benchmarks?|leaderboards?)\b/i

/** The score words `text` says, lowercase, in order. */
export const scoreWordsIn = (text: string): ReadonlyArray<string> =>
  Array.from(text.matchAll(new RegExp(SCORE_WORDS.source, "gi")), (match) =>
    (match[0] ?? "").toLowerCase(),
  )
