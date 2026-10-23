#!/usr/bin/env bun
/**
 * One-command live testbed for the gent TUI.
 *
 *   bun run gamut up <preset> [--prompt <file|text>] [--no-build]
 *   bun run gamut send "<text>"
 *   bun run gamut keys <name…>
 *   bun run gamut interrupt
 *   bun run gamut read [--full]
 *   bun run gamut wait [seconds]
 *   bun run gamut status
 *   bun run gamut restart
 *   bun run gamut down
 *   bun run gamut list
 *
 * `up` copies `fixture/` (the ledgerline app in its red state) to a fresh
 * scratch directory, pins the preset's models, launches this checkout's
 * `apps/tui/bin/gent` on a pty that a detached terminal host keeps
 * (`packages/e2e/src/pty-host.ts`), and records the run in a state file.
 * Every later subcommand reaches the TUI through the host's socket; no
 * terminal multiplexer is needed. Run state stays in that scratch directory.
 * Offline catalog metadata is read from a scratch copy of the selected gent
 * database and its WAL.
 *
 * A plain Bun script: it is a driver for a terminal program, not part of the
 * shipped runtime, and it builds no Effect layer. The pure parts it exports
 * are covered by `testbeds/gamut/tests/gamut.test.ts`.
 *
 * @module
 */

import { $ } from "bun"
import { Database } from "bun:sqlite"
import {
  mkdirSync,
  cpSync,
  renameSync,
  existsSync,
  rmSync,
  realpathSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  copyFileSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { Cause, Config, Effect, Exit, Option, Schema } from "effect"
import { resolveDataDir } from "@gent/core/host"
import { HostConfig, type HostClient, type HostScreen, hostCall } from "@gent/e2e/pty-host"

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = resolve(HERE, "../..")
const FIXTURE = join(HERE, "fixture")
const BINARY = join(CHECKOUT, "apps/tui/bin/gent")

// ── Presets ─────────────────────────────────────────────────────────────

/** One model choice: which model, at which reasoning effort. */
interface Slot {
  readonly modelId: string
  readonly reasoningEffort: string
}

/**
 * A preset pins three roles. The orchestrator is agent `main` and the worker
 * is agent `delegate` in `.gent/config.json`: the pairing every delegate
 * thread runs under when its start names no model. The reviewer reaches the
 * orchestrator through the roster block in `AGENTS.md`, which tells it what
 * `model` and `effort` to pass on a `thread.start` call that wants the second
 * opinion.
 */
interface Preset {
  readonly orchestrator: Slot
  readonly worker: Slot
  readonly reviewer: Slot
}

const slot = (modelId: string, reasoningEffort: string): Slot => ({ modelId, reasoningEffort })

/**
 * The model families a preset names instead of a release. `up` resolves each
 * to the family's newest release in the models.dev catalog, so a preset never
 * pins a release that a newer one replaced. `version` captures the release
 * number, whose Anthropic minor part has at most two digits; a dated snapshot
 * (`claude-opus-4-5-20251101`, `claude-sonnet-4-20250514`) and a variant
 * (`gpt-6-sol-pro`) do not match.
 */
const FAMILIES: Record<string, { readonly provider: string; readonly pattern: RegExp }> = {
  "openai/sol": { provider: "openai", pattern: /^gpt-(?<version>\d+(?:\.\d+)*)-sol$/ },
  "openai/luna": { provider: "openai", pattern: /^gpt-(?<version>\d+(?:\.\d+)*)-luna$/ },
  "anthropic/opus": {
    provider: "anthropic",
    pattern: /^claude-opus-(?<version>\d+(?:-\d{1,2})?)$/,
  },
  "anthropic/sonnet": {
    provider: "anthropic",
    pattern: /^claude-sonnet-(?<version>\d+(?:-\d{1,2})?)$/,
  },
  "anthropic/fable": {
    provider: "anthropic",
    pattern: /^claude-fable-(?<version>\d+(?:-\d{1,2})?)$/,
  },
  "anthropic/haiku": {
    provider: "anthropic",
    pattern: /^claude-haiku-(?<version>\d+(?:-\d{1,2})?)$/,
  },
}

export const PRESETS: Record<string, Preset> = {
  sol: {
    orchestrator: slot("openai/gpt-6.1-sol", "high"),
    worker: slot("openai/gpt-6.1-sol", "high"),
    reviewer: slot("openai/gpt-6.1-sol", "high"),
  },
  "sol-luna": {
    orchestrator: slot("openai/sol", "medium"),
    worker: slot("openai/luna", "max"),
    reviewer: slot("openai/sol", "high"),
  },
  "opus-sonnet": {
    orchestrator: slot("anthropic/opus", "medium"),
    worker: slot("anthropic/sonnet", "high"),
    reviewer: slot("anthropic/opus", "high"),
  },
  "fable-opus": {
    orchestrator: slot("anthropic/fable", "medium"),
    worker: slot("anthropic/opus", "high"),
    reviewer: slot("anthropic/fable", "high"),
  },
  "sonnet-sonnet": {
    orchestrator: slot("anthropic/sonnet", "medium"),
    worker: slot("anthropic/sonnet", "max"),
    reviewer: slot("anthropic/sonnet", "high"),
  },
  mixed: {
    orchestrator: slot("openai/sol", "medium"),
    worker: slot("anthropic/sonnet", "max"),
    reviewer: slot("anthropic/opus", "high"),
  },
  "opus-luna": {
    orchestrator: slot("anthropic/opus", "low"),
    worker: slot("openai/luna", "max"),
    reviewer: slot("anthropic/opus", "high"),
  },
  // The one preset an Anthropic live check may spend the owner's accounts on.
  haiku: {
    orchestrator: slot("anthropic/haiku", "medium"),
    worker: slot("anthropic/haiku", "medium"),
    reviewer: slot("anthropic/haiku", "high"),
  },
}

/** A release number as integers: `5.6` and `5-6` both read `[5, 6]`. */
const versionParts = (version: string): ReadonlyArray<number> =>
  version.split(/[.-]/).map((part) => Number(part))

const newerVersion = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/** The newest release of a family among one provider's model ids (`gpt-6-sol`, not `openai/gpt-6-sol`). */
export const newestInFamily = (
  family: string,
  modelIds: ReadonlyArray<string>,
): string | undefined => {
  const entry = FAMILIES[family]
  if (entry === undefined) return undefined
  let best: { readonly id: string; readonly parts: ReadonlyArray<number> } | undefined
  for (const id of modelIds) {
    const version = entry.pattern.exec(id)?.groups?.["version"]
    if (version === undefined) continue
    const parts = versionParts(version)
    if (best === undefined || newerVersion(parts, best.parts)) best = { id, parts }
  }
  return best === undefined ? undefined : `${entry.provider}/${best.id}`
}

/**
 * The preset with each family resolved to its newest release. `catalog` maps
 * a provider id to its model ids. A family with no release in the catalog
 * stops the run: a guessed id would fail inside the TUI instead.
 */
export const resolvePreset = (
  preset: Preset,
  catalog: Readonly<Record<string, ReadonlyArray<string>>>,
): Preset => {
  const resolveSlot = (role: Slot): Slot => {
    const entry = FAMILIES[role.modelId]
    if (entry === undefined) return role
    const newest = newestInFamily(role.modelId, catalog[entry.provider] ?? [])
    if (newest === undefined) {
      throw new Error(`no ${role.modelId} release in the models.dev catalog`)
    }
    return { ...role, modelId: newest }
  }
  return {
    orchestrator: resolveSlot(preset.orchestrator),
    worker: resolveSlot(preset.worker),
    reviewer: resolveSlot(preset.reviewer),
  }
}

const MODELS_DEV_URL = "https://models.dev/api.json"
const ModelsDevPayload = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({ models: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
)
/**
 * The models.dev catalog as provider → model ids. Offline, read the chat
 * snapshot gent stores in its database, through a scratch copy of it and
 * its WAL. The selected database is never opened or changed here.
 */
const loadCatalog = async (): Promise<Record<string, ReadonlyArray<string>>> => {
  const decode = (body: string): Record<string, ReadonlyArray<string>> => {
    const payload = Schema.decodeSync(ModelsDevPayload)(body)
    return Object.fromEntries(
      Object.entries(payload).map(([provider, entry]) => [provider, Object.keys(entry.models)]),
    )
  }
  try {
    // curl, as the script shells out to git and bun: it builds no Effect layer.
    return decode(await $`curl -sf -m 15 ${MODELS_DEV_URL}`.quiet().text())
  } catch (error) {
    const dbPath = resolve(Effect.runSync(resolveDataDir(homedir())), "data.db")
    if (!existsSync(dbPath)) throw error
    const scratch = mkdtempSync(join(tmpdir(), "gent-gamut-catalog-"))
    const copy = join(scratch, "data.db")
    try {
      await $`/bin/cp ${dbPath} ${copy}`.quiet()
      if (existsSync(dbPath + "-wal")) {
        await $`/bin/cp ${dbPath + "-wal"} ${copy + "-wal"}`.quiet()
      }
      const db = new Database(copy, { readonly: true })
      let catalog: Record<string, ReadonlyArray<string>>
      try {
        const row = Schema.decodeUnknownSync(Schema.Struct({ body: Schema.String }))(
          db.query("SELECT body FROM model_catalog_snapshots WHERE source = 'api.json'").get(),
        )
        catalog = decode(row.body)
      } finally {
        db.close()
      }
      console.log(`models.dev unreachable (${String(error)}); using ${dbPath} chat snapshot`)
      return catalog
    } catch {
      // A missing or invalid snapshot leaves the caller's fetch error intact.
      throw error
    } finally {
      await removeTree(scratch)
    }
  }
}

// ── Pure transforms ─────────────────────────────────────────────────────

/**
 * `.gent/config.json` for a preset: the orchestrator as agent `main`, the
 * worker as agent `delegate`. The machine tiers name the reviewer as
 * `strongest` and the worker as `efficient`; a project list shadows the
 * owner's, so a run never reaches a model outside its preset.
 */
export const presetConfigJson = (preset: Preset): string =>
  `${JSON.stringify(
    {
      agents: { main: agentEntry(preset.orchestrator), delegate: agentEntry(preset.worker) },
      tiers: { strongest: [preset.reviewer.modelId], efficient: [preset.worker.modelId] },
    },
    null,
    2,
  )}\n`

/** A slot as a config `agents` entry: its model and effort. */
const agentEntry = (slot: Slot) => ({ model: slot.modelId, reasoningEffort: slot.reasoningEffort })

const ROSTER_START = "<!-- roster -->"
const ROSTER_END = "<!-- /roster -->"

/** The roster block body for a preset, markers included. */
export const rosterBlock = (preset: Preset): string =>
  [
    ROSTER_START,
    `- Worker (fix or feature): the \`delegate\` agent, paired in \`.gent/config.json\` as \`${preset.worker.modelId}\` at \`${preset.worker.reasoningEffort}\`.`,
    `- Reviewer (second opinion on a diff): \`model\` = \`${preset.reviewer.modelId}\`, \`effort\` = \`${preset.reviewer.reasoningEffort}\``,
    "- Repetitive mechanical changes following an established pattern only: `model` = `openai/gpt-6-luna`, `effort` = `max`. Include transformation rules, worked examples, and the validation command in the task.",
    ROSTER_END,
  ].join("\n")

/**
 * Replace the roster block in an `AGENTS.md` body. The markers are the
 * contract: text outside them is the orchestration prose the agent reads, and
 * it survives every preset switch.
 */
export const rewriteRoster = (agentsMd: string, preset: Preset): string => {
  const start = agentsMd.indexOf(ROSTER_START)
  const end = agentsMd.indexOf(ROSTER_END)
  if (start < 0 || end < 0) throw new Error("AGENTS.md has no roster block")
  return agentsMd.slice(0, start) + rosterBlock(preset) + agentsMd.slice(end + ROSTER_END.length)
}

/**
 * What `up` records so every later subcommand can find the run: the state
 * file as `up` and `send` write it, two-space indented. It lives for one
 * `up`/`down` cycle.
 */
const StateFile = Schema.fromJsonString(
  Schema.Struct({
    root: Schema.String,
    work: Schema.String,
    data: Schema.String,
    /** The terminal host's socket, and its process id for a `down` that finds it wedged. */
    socket: Schema.String,
    hostPid: Schema.Finite,
    binary: Schema.String,
    preset: Schema.String,
    /**
     * The newest event id when `send` last typed a message (zero until then).
     * `wait` counts only a turn newer than it, so the turn the previous prompt
     * finished cannot pass for the one just sent.
     */
    sendMark: Schema.Finite,
    /**
     * Whether the last thing typed starts a turn. A prompt does; a slash
     * command (`/model …`, `/goal status`) runs in the client and may start
     * none, so `wait` takes any event stored after the send as proof it was
     * handled, or a quiet period when it stores nothing (`waitStep`).
     */
    awaitsTurn: Schema.Boolean,
  }),
  { space: 2 },
)

export type GamutState = typeof StateFile.Type

export const encodeState = (state: GamutState): string => `${Schema.encodeSync(StateFile)(state)}\n`

export const decodeState = (text: string): GamutState => Schema.decodeSync(StateFile)(text)

// ── State file ──────────────────────────────────────────────────────────

/**
 * The filename carries the checkout name. `readState` also checks the
 * canonical checkout path: two checkouts with the same name must refuse
 * each other's run, not stop its TUI or remove its scratch tree.
 */
export const stateFileFor = (checkoutRoot: string): string =>
  join(tmpdir(), `gent-gamut-${basename(checkoutRoot)}.json`)

const STATE_FILE = stateFileFor(CHECKOUT)

const readState = async (): Promise<GamutState> => {
  const file = Bun.file(STATE_FILE)
  if (!(await file.exists())) {
    throw new Error(`no gamut run is up (${STATE_FILE} is missing). Run: bun run gamut up <preset>`)
  }
  const state = decodeState(await file.text())
  const owner = realpathSync(resolve(dirname(state.binary), "../../.."))
  if (owner !== realpathSync(CHECKOUT)) {
    throw new Error(`gamut run belongs to another checkout (${owner}); refusing ${STATE_FILE}`)
  }
  return state
}

// ── The default prompt ──────────────────────────────────────────────────

/**
 * Written the way a person asks, not as a checklist: the run is meant to
 * exercise how the orchestrator plans and splits work on its own.
 */
const DEFAULT_PROMPT =
  "Can you work through the open tasks in the README? AGENTS.md says how to " +
  "split them up. Run the tests and typecheck when you're done and tell me " +
  "how each one went."

/** `--prompt` takes a file path or the prompt text itself. */
const resolvePrompt = async (value: string): Promise<string> => {
  const file = Bun.file(value)
  if (await file.exists()) return (await file.text()).trim()
  return value
}

// ── Terminal host ───────────────────────────────────────────────────────

/** The host's entry; `isHost` also finds a run's host by it in `ps`. */
const HOST_ENTRY = fileURLToPath(import.meta.resolve("@gent/e2e/pty-host"))

/** The size the TUI draws at: wide enough that the status line keeps every item. */
const HOST_SIZE = { cols: 120, rows: 40 }

/**
 * The one line to show for a failed command: its last non-empty stderr
 * line, then its last stdout line.
 */
export const failureText = (stdout: string, stderr: string): string => {
  const lastLine = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1)
  return lastLine(stderr) ?? lastLine(stdout) ?? "no output"
}

/** Whether `pid` is still a terminal host, not a process that reused its id. */
const isHost = async (pid: number): Promise<boolean> => {
  const ps = await $`ps -o command= -p ${pid}`.quiet().nothrow()
  return ps.exitCode === 0 && ps.stdout.toString().includes(HOST_ENTRY)
}

/**
 * Call the run's host. A host that has stopped (the machine slept, a kill)
 * is named as such, with the log that says why; any other failure keeps
 * its own message (an unknown key, a TUI that will not quit).
 */
const callHost = async <A, E>(
  state: GamutState,
  use: (host: HostClient) => Effect.Effect<A, E>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(hostCall(state.socket, use))
  if (Exit.isSuccess(exit)) return exit.value
  if (!(await isHost(state.hostPid))) {
    throw new Error(
      `the run's terminal host has stopped (see ${join(state.root, "host.log")}); run: bun run gamut down`,
    )
  }
  const error = Cause.squash(exit.cause)
  throw new Error(error instanceof Error ? error.message : String(error))
}

const encodeHostConfig = Schema.encodeSync(Schema.fromJsonString(HostConfig))

/**
 * Start the terminal host, detached so it outlives this command, and wait
 * for its socket. The config holds the TUI's whole environment, proxy
 * values included, so it is written owner-only and the host removes it
 * once read; none of it reaches a process argument.
 */
const startHost = async (root: string, config: HostConfig): Promise<number> => {
  const file = join(root, "host.json")
  writeFileSync(file, encodeHostConfig(config), { mode: 0o600 })
  const logPath = join(root, "host.log")
  const log = openSync(logPath, "a")
  const host = Bun.spawn([process.execPath, HOST_ENTRY, file], {
    stdio: ["ignore", log, log],
    detached: true,
  })
  closeSync(log)
  host.unref()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (host.exitCode !== null) {
      const said = failureText("", await Bun.file(logPath).text())
      throw new Error(`the terminal host exited ${host.exitCode}: ${said}`)
    }
    if (existsSync(config.socket)) return host.pid
    await Bun.sleep(100)
  }
  host.kill("SIGKILL")
  throw new Error(`the terminal host opened no socket within 10s; see ${logPath}`)
}

// ── up ──────────────────────────────────────────────────────────────────

const up = async (presetName: string, promptArg: string | undefined, build: boolean) => {
  const named = PRESETS[presetName]
  if (!named) {
    throw new Error(`unknown preset: ${presetName}. Presets: ${Object.keys(PRESETS).join(", ")}`)
  }
  if (existsSync(STATE_FILE)) {
    throw new Error(`a gamut run is already up (${STATE_FILE}). Run: bun run gamut down`)
  }
  const preset = resolvePreset(named, await loadCatalog())

  const root = join(tmpdir(), `gent-gamut-${Date.now()}`)
  // Until the state file names `root`, `down` cannot find it: a failed `up`
  // removes it here instead.
  try {
    await prepareAndLaunch(presetName, preset, promptArg, build, root)
  } catch (error) {
    if (!existsSync(STATE_FILE)) await removeTree(root)
    throw error
  }
}

/** `trash` is this machine's guardrail for deletes; fall back when absent. */
const removeTree = async (path: string): Promise<void> => {
  const trashed = await $`trash ${path}`.quiet().nothrow()
  if (trashed.exitCode !== 0) rmSync(path, { recursive: true, force: true })
}

/**
 * The owner's `~/.gent` entries a run never shares: the user config, which
 * five writers in the TUI can reach (the first `/model` pick, a driver
 * override set or cleared, the auth order, a renamed auth slot), and the
 * database files, which `GENT_DATA_DIR` moves to the run's own directory.
 */
const isUnsharedGentEntry = (name: string): boolean =>
  name === "config.json" || name.startsWith("data.db")

/**
 * Build the run's home at `runHome` from the owner's `ownerHome`. Each
 * top-level entry links to the owner's, so the login, the skills, the
 * shell and git read as they do outside the run. `.gent` is the run's own
 * directory: its entries link to the owner's too, except the user config,
 * which is a copy the run's writers change, and the database files.
 * A link is removed as a link, so `down` never reaches the owner's files.
 */
const buildRunHome = (ownerHome: string, runHome: string): void => {
  mkdirSync(join(runHome, ".gent"), { recursive: true })
  for (const entry of readdirSync(ownerHome)) {
    if (entry !== ".gent") symlinkSync(join(ownerHome, entry), join(runHome, entry))
  }
  const ownerGent = join(ownerHome, ".gent")
  if (!existsSync(ownerGent)) return
  for (const entry of readdirSync(ownerGent)) {
    if (!isUnsharedGentEntry(entry))
      symlinkSync(join(ownerGent, entry), join(runHome, ".gent", entry))
  }
  const config = join(ownerGent, "config.json")
  if (existsSync(config)) copyFileSync(config, join(runHome, ".gent", "config.json"))
}

const prepareAndLaunch = async (
  presetName: string,
  preset: Preset,
  promptArg: string | undefined,
  build: boolean,
  root: string,
) => {
  const work = join(root, "work")
  const data = join(root, "data")
  mkdirSync(work, { recursive: true })
  mkdirSync(data, { recursive: true })

  // The fixture ships its ignore file under a neutral name so the repo's own
  // git does not apply it to the checked-in copy.
  cpSync(FIXTURE, work, { recursive: true })
  renameSync(join(work, ".gitignore.fixture"), join(work, ".gitignore"))

  await Bun.write(join(work, ".gent/config.json"), presetConfigJson(preset))
  const agentsPath = join(work, "AGENTS.md")
  await Bun.write(agentsPath, rewriteRoster(await Bun.file(agentsPath).text(), preset))

  console.log(`work  ${work}`)
  console.log(`data  ${data}`)
  console.log(
    `preset ${presetName}  orchestrator ${preset.orchestrator.modelId}  worker ${preset.worker.modelId}  reviewer ${preset.reviewer.modelId}`,
  )

  console.log("installing…")
  await $`bun install --silent`.cwd(work).quiet()

  // A git repo so the agent can diff, and so a child's edits are recoverable.
  await $`git init -q`.cwd(work).quiet()
  await $`git add -A`.cwd(work).quiet()
  await $`git -c user.name=gamut -c user.email=gamut@local commit -q -m "ledgerline: red suite with six open tasks"`
    .cwd(work)
    .quiet()

  if (build) {
    // Build from THIS checkout. `gent` and its `gent-cell` worker are compiled
    // binaries: source edits show nothing until a rebuild, and `~/.local/bin/gent`
    // may be another build. The root build is turbo's, so an unchanged checkout
    // is a cache hit. The build never claims the global name; only
    // `bun run install:global` does.
    console.log("building gent from this checkout…")
    await $`bun run build`.cwd(CHECKOUT).quiet()
  }
  if (!existsSync(BINARY)) throw new Error(`no binary at ${BINARY}; run without --no-build`)

  const prompt = promptArg === undefined ? DEFAULT_PROMPT : await resolvePrompt(promptArg)

  // GENT_DATA_DIR redirects `data.db`, and HOME gives the run a home of its
  // own (`buildRunHome`): the run writes a copy of the user config, while
  // the login and the other tools' files stay the owner's.
  const home = join(root, "home")
  buildRunHome(homedir(), home)
  const socket = join(root, "host.sock")
  const hostPid = await startHost(root, {
    socket,
    cwd: work,
    command: [BINARY, "-p", prompt],
    env: {
      ...Effect.runSync(terminalEnv),
      HOME: home,
      GENT_DATA_DIR: data,
      ...Effect.runSync(proxyEnv),
    },
    ...HOST_SIZE,
  })

  const state: GamutState = {
    root,
    work,
    data,
    socket,
    hostPid,
    binary: BINARY,
    preset: presetName,
    sendMark: 0,
    awaitsTurn: true,
  }
  await Bun.write(STATE_FILE, encodeState(state))
  console.log(`host  ${hostPid} on ${socket}`)
  console.log(`state ${STATE_FILE}`)
}

/** The caller's variables among `names`, by name; an empty variable reads as unset. */
const callerVariables = (
  names: ReadonlyArray<string>,
): Effect.Effect<Readonly<Record<string, string>>> =>
  Effect.forEach(names, (name) =>
    Config.option(Config.NonEmptyString(name)).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.map((value) =>
        Option.match(value, {
          onNone: () => [],
          onSome: (text) => [[name, text] as const],
        }),
      ),
    ),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries.flat())))

/**
 * The caller's terminal basics, which the TUI's otherwise empty environment
 * starts from. The host passes nothing else through: the run's home, its
 * data directory and the proxy variables (`proxyEnv`) are added by name.
 */
const TERMINAL_VARIABLES = ["PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "LANG"] as const

const terminalEnv: Effect.Effect<Readonly<Record<string, string>>> = callerVariables(
  TERMINAL_VARIABLES,
).pipe(Effect.map((variables) => ({ ...variables, COLORTERM: "truecolor" })))

// ── status ──────────────────────────────────────────────────────────────

const SessionRow = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  parent_session_id: Schema.NullOr(Schema.String),
})
type SessionRow = typeof SessionRow.Type

/** SQLite rows are untyped: each read decodes the shape its query selects. */
const decodeRows = <S extends Schema.Decoder<unknown>>(
  schema: S,
  rows: unknown,
): ReadonlyArray<S["Type"]> => Schema.decodeUnknownSync(Schema.Array(schema))(rows)

const decodeRow = <S extends Schema.Decoder<unknown>>(
  schema: S,
  row: unknown,
): S["Type"] | undefined => (row === null ? undefined : Schema.decodeSync(schema)(row))

/** Indent a session by its depth in the parent chain. */
const sessionTree = (
  rows: ReadonlyArray<SessionRow>,
): ReadonlyArray<{ row: SessionRow; depth: number }> => {
  const byParent = new Map<string | null, Array<SessionRow>>()
  for (const row of rows) {
    const key = row.parent_session_id
    const siblings = byParent.get(key) ?? []
    siblings.push(row)
    byParent.set(key, siblings)
  }
  const out: Array<{ row: SessionRow; depth: number }> = []
  const walk = (parent: string | null, depth: number): void => {
    for (const row of byParent.get(parent) ?? []) {
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  walk(null, 0)
  // A child whose parent is outside this database still has to appear.
  const seen = new Set(out.map((entry) => entry.row.id))
  for (const row of rows) if (!seen.has(row.id)) out.push({ row, depth: 0 })
  return out
}

/**
 * Stored `ExtensionStateChanged` events per extension id, most first: how
 * often each extension told its client widgets to refetch during the run.
 */
export const extensionPulses = (
  db: Database,
): ReadonlyArray<{ readonly extension: string; readonly count: number }> =>
  decodeRows(
    Schema.Struct({ extension: Schema.String, count: Schema.Finite }),
    db
      .query(
        `SELECT json_extract(event_json, '$.extensionId') AS extension, COUNT(*) AS count
         FROM events WHERE event_tag = 'ExtensionStateChanged'
         GROUP BY extension ORDER BY count DESC, extension`,
      )
      .all(),
  )

/**
 * The prompt size of the run's model calls, from `StreamEnded.usage.inputTokens`
 * (the whole prompt, cache reads included), the root sessions and the children
 * apart.
 */
export const contextPerCall = (
  db: Database,
): ReadonlyArray<{
  readonly role: "root" | "child"
  readonly calls: number
  readonly mean: number
  readonly max: number
}> =>
  decodeRows(
    Schema.Struct({
      role: Schema.Literals(["root", "child"]),
      calls: Schema.Finite,
      mean: Schema.Finite,
      max: Schema.Finite,
    }),
    db
      .query(
        `SELECT CASE WHEN s.parent_session_id IS NULL THEN 'root' ELSE 'child' END AS role,
           COUNT(*) AS calls,
           ROUND(AVG(json_extract(e.event_json, '$.usage.inputTokens'))) AS mean,
           MAX(json_extract(e.event_json, '$.usage.inputTokens')) AS max
         FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE e.event_tag = 'StreamEnded'
           AND json_extract(e.event_json, '$.usage.inputTokens') IS NOT NULL
         GROUP BY role ORDER BY role DESC`,
      )
      .all(),
  )

/** An extension makes its tables at its first build, so a database before it has none. */
const hasTable = (db: Database, name: string): boolean =>
  db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== null

/** Each tool call a cell made, with the cell's own call. */
const cellLinks = (
  db: Database,
): ReadonlyArray<{ readonly cell: string; readonly inner: string }> => {
  if (!hasTable(db, "cell_tool_operations")) return []
  return decodeRows(
    Schema.Struct({ cell: Schema.String, inner: Schema.String }),
    db
      .query(
        `SELECT cell_tool_call_id AS cell, json_extract(record_json, '$.toolCallId') AS inner
         FROM cell_tool_operations`,
      )
      .all(),
  )
}

/**
 * An estimate of how much of what the cells answered the model is a file
 * read again: `cellChars`, the output of every cell, failed ones included,
 * and `reread`, its re-read part. A `read` inside a cell answers the cell's
 * code, not the model, so a cell whose reads name a path its session read
 * before counts those reads' output, at most the cell's own. A path counts
 * as read once a read of it succeeded. Not seen: `context.read` of the
 * session's history, a value a cell kept from an earlier cell, a `read`
 * the model called outside a cell, a re-read through bash, and a cell that
 * prints one read twice. So this is not a bound.
 */
export const rereadEstimate = (
  db: Database,
): { readonly cellChars: number; readonly reread: number } => {
  const calls = decodeRows(
    Schema.Struct({
      session: Schema.String,
      call: Schema.String,
      tool: Schema.String,
      path: Schema.NullOr(Schema.String),
    }),
    db
      .query(
        `SELECT session_id AS session, json_extract(event_json, '$.toolCallId') AS call,
           json_extract(event_json, '$.toolName') AS tool,
           json_extract(event_json, '$.input.path') AS path
         FROM events WHERE event_tag = 'ToolCallStarted' ORDER BY id`,
      )
      .all(),
  )
  // How each call ended, joined here: a join on extracted ids scans the events once per call.
  const ended = new Map(
    decodeRows(
      Schema.Struct({
        call: Schema.String,
        chars: Schema.NullOr(Schema.Finite),
        ok: Schema.Finite,
      }),
      db
        .query(
          `SELECT json_extract(event_json, '$.toolCallId') AS call,
             LENGTH(json_extract(event_json, '$.output')) AS chars,
             event_tag = 'ToolCallSucceeded' AS ok
           FROM events WHERE event_tag IN ('ToolCallSucceeded', 'ToolCallFailed')`,
        )
        .all(),
    ).map(({ call, chars, ok }) => [call, { chars: chars ?? 0, ok: ok === 1 }]),
  )
  // A tool call a cell made, by the cell's own call.
  const cellOf = new Map(cellLinks(db).map(({ cell, inner }) => [inner, cell]))
  const outputOf = (call: string) => ended.get(call)?.chars ?? 0
  const readBy = new Map<string, Set<string>>()
  const readAgain = new Map<string, number>()
  for (const { session, call, tool, path } of calls) {
    if (tool !== "read" || path === null) continue
    const paths = readBy.get(session) ?? new Set<string>()
    const cell = cellOf.get(call)
    if (paths.has(path) && cell !== undefined)
      readAgain.set(cell, (readAgain.get(cell) ?? 0) + outputOf(call))
    if (ended.get(call)?.ok === true) paths.add(path)
    readBy.set(session, paths)
  }
  let cellChars = 0
  for (const { call, tool } of calls) if (tool === "cell") cellChars += outputOf(call)
  let reread = 0
  for (const [cell, chars] of readAgain) reread += Math.min(chars, outputOf(cell))
  return { cellChars, reread }
}

/**
 * The orchestrate machine's gate failures per unit: `units`, its runs (one
 * unit each), `gateFails`, its moves from the merge gate by `fail`, and
 * `mergeReds`, its moves from `merge` by `red`. Both failures send the unit
 * back to `resume`, so one unit can fail more than once.
 */
export const gateFailures = (
  db: Database,
): { readonly units: number; readonly gateFails: number; readonly mergeReds: number } => {
  if (!hasTable(db, "machine_runs") || !hasTable(db, "machine_steps"))
    return { units: 0, gateFails: 0, mergeReds: 0 }
  const [row] = decodeRows(
    Schema.Struct({ units: Schema.Finite, gateFails: Schema.Finite, mergeReds: Schema.Finite }),
    db
      .query(
        `SELECT (SELECT COUNT(*) FROM machine_runs WHERE machine = 'orchestrate') AS units,
           COUNT(CASE WHEN json_extract(s.step_json, '$.from') = 'gate'
                       AND json_extract(s.step_json, '$.by') = 'fail' THEN 1 END) AS gateFails,
           COUNT(CASE WHEN json_extract(s.step_json, '$.from') = 'merge'
                       AND json_extract(s.step_json, '$.by') = 'red' THEN 1 END) AS mergeReds
         FROM machine_steps s JOIN machine_runs r ON r.run = s.run
         WHERE r.machine = 'orchestrate' AND json_extract(s.step_json, '$._tag') = 'Moved'`,
      )
      .all(),
  )
  return row ?? { units: 0, gateFails: 0, mergeReds: 0 }
}

/** One session of the run: its place in the parent chain, its last model and its tool calls. */
interface SessionStatus {
  readonly row: SessionRow
  readonly depth: number
  readonly model: string | null
  readonly toolCalls: number
}

/** The sessions of the run, each under its parent. */
export const sessionStatuses = (db: Database): ReadonlyArray<SessionStatus> => {
  const sessions = decodeRows(
    SessionRow,
    db.query(`SELECT id, name, parent_session_id FROM sessions ORDER BY created_at`).all(),
  )
  // `StreamEnded.model` is where the model that produced a step is recorded.
  const modelOf = db.query(
    `SELECT json_extract(event_json, '$.model') AS model FROM events
     WHERE session_id = ? AND event_tag = 'StreamEnded'
       AND json_extract(event_json, '$.model') IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  )
  const toolCallsOf = db.query(
    `SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND event_tag = 'ToolCallStarted'`,
  )
  return sessionTree(sessions).map(({ row, depth }) => ({
    row,
    depth,
    model:
      decodeRow(Schema.Struct({ model: Schema.NullOr(Schema.String) }), modelOf.get(row.id))
        ?.model ?? null,
    toolCalls: decodeRow(Schema.Struct({ n: Schema.Finite }), toolCallsOf.get(row.id))?.n ?? 0,
  }))
}

/** The text part of every user message, in the order the run stored them. */
export const userMessageTexts = (
  db: Database,
): ReadonlyArray<{ readonly session_id: string; readonly text: string | null }> =>
  // A user message's text lives in the chunk parts, one row per part.
  decodeRows(
    Schema.Struct({ session_id: Schema.String, text: Schema.NullOr(Schema.String) }),
    db
      .query(
        `SELECT m.session_id AS session_id, json_extract(cc.part_json, '$.text') AS text
         FROM messages m
         JOIN message_chunks mc ON mc.message_id = m.id
         JOIN content_chunks cc ON cc.id = mc.chunk_id
         WHERE m.role = 'user' AND json_extract(cc.part_json, '$.type') = 'text'
         ORDER BY m.created_at, mc.ordinal`,
      )
      .all(),
  )

const status = async () => {
  const state = await readState()
  const dbPath = join(state.data, "data.db")
  if (!existsSync(dbPath)) {
    console.log(`no database yet at ${dbPath} — the run has not stored a turn`)
    return
  }
  const db = new Database(dbPath, { readonly: true })

  console.log("sessions:")
  for (const { row, depth, model, toolCalls } of sessionStatuses(db)) {
    const indent = "  ".repeat(depth + 1)
    console.log(
      `${indent}${row.id}  ${row.name ?? "(unnamed)"}  model=${model ?? "-"}  toolCalls=${toolCalls}`,
    )
  }

  const userMessages = userMessageTexts(db)
  console.log(`\nuser messages (${userMessages.length}):`)
  for (const message of userMessages) {
    console.log(`  [${message.session_id.slice(-8)}] ${JSON.stringify(message.text)}`)
  }

  const pulses = extensionPulses(db)
  console.log(`\nextension pulses (stored ExtensionStateChanged, ${pulses.length} extensions):`)
  for (const { extension, count } of pulses) console.log(`  ${extension}  ${count}`)

  console.log("\ncontext per model call (input tokens):")
  for (const { role, calls, mean, max } of contextPerCall(db))
    console.log(`  ${role}  calls=${calls}  mean=${mean}  max=${max}`)
  const reread = rereadEstimate(db)
  const share = (100 * reread.reread) / Math.max(reread.cellChars, 1)
  console.log(
    `re-read files (estimate): ${reread.reread} of ${reread.cellChars} cell output chars (${share.toFixed(1)}%)`,
  )
  const gates = gateFailures(db)
  console.log(
    `orchestrate units: ${gates.units}  gate fails: ${gates.gateFails}  merge reds: ${gates.mergeReds}`,
  )
  db.close()

  console.log("\nbun test in the work dir:")
  const tests = await $`bun test`.cwd(state.work).quiet().nothrow()
  console.log(`  ${testSummary(tests.stderr.toString() + tests.stdout.toString())}`)
}

/**
 * `17 pass, 0 fail` from a `bun test` run. Bun colours its summary even when
 * piped (`\x1b[0m\x1b[32m 17 pass`), so the colour is stripped before reading.
 */
export const testSummary = (output: string): string => {
  const plain = Bun.stripANSI(output)
  const pass = /^\s*(\d+) pass/m.exec(plain)?.[1] ?? "?"
  const fail = /^\s*(\d+) fail/m.exec(plain)?.[1] ?? "?"
  return `${pass} pass, ${fail} fail`
}

// ── the rest ────────────────────────────────────────────────────────────

/** A prompt starts a turn; a slash command runs in the client and may start none. */
export const sendAwaitsTurn = (text: string): boolean => !text.trimStart().startsWith("/")

const send = async (text: string) => {
  const state = await readState()
  // Mark before typing: the message is stored after this id.
  await Bun.write(
    STATE_FILE,
    encodeState({
      ...state,
      sendMark: latestEventIn(state.data),
      awaitsTurn: sendAwaitsTurn(text),
    }),
  )
  // The text goes into the composer verbatim and Enter submits it.
  await callHost(state, (host) =>
    host.type({ text }).pipe(Effect.andThen(host.keys({ names: ["enter"] }))),
  )
}

/** Press named keys in order (`ctrl+c`, `esc`, `down`, `tab`, …). */
const pressKeys = async (names: ReadonlyArray<string>) => {
  const state = await readState()
  await callHost(state, (host) => host.keys({ names }))
}

/**
 * What `read` prints: the rows added since the last read (`(no change)` when
 * none), or the whole screen with `--full`, then how many rows of the last
 * read are gone and, once it has exited, the TUI's exit code.
 */
export const screenText = (screen: HostScreen, full: boolean): string => {
  const lines = [...screen.rows]
  if (!full && lines.length === 0) lines.push("(no change)")
  if (screen.gone > 0) lines.push(`(${screen.gone} rows of the last read are gone)`)
  if (screen.exited !== undefined) lines.push(`(gent exited ${screen.exited})`)
  return lines.join("\n")
}

const read = async (full: boolean) => {
  const state = await readState()
  const scope = full ? "full" : "changes"
  console.log(screenText(await callHost(state, (host) => host.read({ scope })), full))
}

/**
 * What the run's own events say: whether any turn has started, and which
 * sessions have a turn that has not ended. A turn starts with a user-role
 * `MessageReceived` (a prompt, a wake, a child's completion) or a
 * `StreamStarted`. It ends with `TurnCompleted` alone, a failed turn too.
 * The screen shows the agents tray only while it is on screen, so a
 * child still working can be invisible there; the events are the record.
 */
export interface RunRecord {
  readonly started: boolean
  readonly open: ReadonlyArray<string>
  /**
   * Whether any event was stored after the send mark: the trace a handled
   * slash command leaves (its own record, a note, a queued prompt).
   */
  readonly stored: boolean
}

/**
 * The events that start a turn. An assistant or tool `MessageReceived` is
 * stored inside a turn, or outside one when a command presents a note
 * (`/goal status` stores a hidden assistant message), so it starts nothing.
 */
const TURN_START = `(event_tag = 'StreamStarted'
  OR (event_tag = 'MessageReceived' AND json_extract(event_json, '$.message.role') = 'user'))`

/**
 * The sessions with a turn started after their last `TurnCompleted`. Every
 * admitted turn ends with exactly one `TurnCompleted`; an `ErrorOccurred` may
 * be a notice in a turn that goes on (context-overflow recovery, a compaction
 * fallback), so it ends nothing.
 */
export const openTurnSessions = (db: Database): ReadonlyArray<string> =>
  decodeRows(
    Schema.Struct({ session_id: Schema.String }),
    db
      .query(
        `SELECT session_id FROM events GROUP BY session_id
         HAVING MAX(CASE WHEN ${TURN_START} THEN id END)
           > COALESCE(MAX(CASE WHEN event_tag = 'TurnCompleted' THEN id END), 0)`,
      )
      .all(),
  ).map((row) => row.session_id)

/** A turn has started after `sendMark` (an event id), which turns are open, and whether anything was stored since. */
export const runRecord = (db: Database, sendMark: number): RunRecord => ({
  started:
    db.query(`SELECT 1 FROM events WHERE ${TURN_START} AND id > ? LIMIT 1`).get(sendMark) !== null,
  open: openTurnSessions(db),
  stored: db.query(`SELECT 1 FROM events WHERE id > ? LIMIT 1`).get(sendMark) !== null,
})

/** The newest event id, zero before any event. */
export const latestEventId = (db: Database): number =>
  Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.query(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).get(),
  ).id

const readRunDb = <A>(dataDir: string, absent: A, read: (db: Database) => A): A => {
  const dbPath = join(dataDir, "data.db")
  if (!existsSync(dbPath)) return absent
  const db = new Database(dbPath, { readonly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

const runRecordIn = (dataDir: string, sendMark: number): RunRecord =>
  readRunDb(dataDir, { started: false, open: [], stored: false }, (db) => runRecord(db, sendMark))

const latestEventIn = (dataDir: string): number => readRunDb(dataDir, 0, latestEventId)

/**
 * Whether the screen shows a working child: a running child's tray row starts
 * with its pulse (`◇◈◆◈`, `workingIconFrame` in `apps/tui/src/utils.ts`).
 * `◆` is also a done thread's glyph, so only the other two frames read busy:
 * idle needs several reads in a row, and the record's open turns cover a
 * stored child too. The row covers a child that is admitted and not yet
 * stored. The TUI's agents tests render the tray and check this predicate on
 * the frame, so a change to the row turns them red.
 */
export const screenShowsWorkingChild = (screenText: string): boolean =>
  screenText.split("\n").some((line) => /^[◇◈] /.test(line.trim()))

/**
 * Whether the run is idle: every turn has ended in the record and the
 * screen shows no working child. The record holds the turn state; no screen
 * row stands for it. The live line and the turn line share the `✻` glyph, so
 * a screen check on it read a finished turn as busy. The footer cannot say idle
 * either: its first slot shows `idle`, `ready`, a held error or an extension
 * notice (`apps/tui/src/app.tsx`, `phaseLabels`), the last two free text.
 */
const isIdle = (screenText: string, record: RunRecord): boolean =>
  record.open.length === 0 && !screenShowsWorkingChild(screenText)

/** Where a wait stands: idle reads in a row with and without proof the send was handled. */
interface WaitProgress {
  readonly settledReads: number
  readonly quietReads: number
}

export const WAIT_START: WaitProgress = { settledReads: 0, quietReads: 0 }

/**
 * Idle reads in a row (3 s apart) after which a slash command that stored
 * nothing is taken as handled. A command that queues a turn (`/plan`,
 * `/review`) stores its prompt well inside this window.
 */
export const QUIET_READS = 5

/**
 * Fold one screen read into the wait. An idle read counts only with proof the
 * send was handled: a turn started after it for a prompt, any stored event
 * after it for a slash command (its record, a note, a queued prompt). Two such
 * reads in a row settle: a background child's result starts a new turn by
 * itself. A slash command that leaves no trace settles after `QUIET_READS`
 * idle reads. A busy read starts the count again.
 */
export const waitStep = (
  progress: WaitProgress,
  screenText: string,
  record: RunRecord,
  awaitsTurn: boolean,
): WaitProgress => {
  if (!isIdle(screenText, record)) return WAIT_START
  const handled = awaitsTurn ? record.started : record.stored
  if (handled) return { settledReads: progress.settledReads + 1, quietReads: 0 }
  if (awaitsTurn) return WAIT_START
  return { settledReads: 0, quietReads: progress.quietReads + 1 }
}

export const isSettled = (progress: WaitProgress): boolean =>
  progress.settledReads >= 2 || progress.quietReads >= QUIET_READS

/** A positive whole count (seconds, lines) from the command line; anything else is refused. */
export const parseCount = (name: string, value: string): number => {
  const count = Number(value)
  if (!/^\d+$/.test(value) || count <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(value)}`)
  }
  return count
}

const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "ANTHROPIC_BASE_URL",
] as const

/**
 * The caller's proxy variables, for the TUI's environment. The TUI takes no
 * other variable from the caller, so `eval "$(teamclaude env --mitm)"` (or
 * `--no-mitm`, which sets `ANTHROPIC_BASE_URL`) before `up` reaches the run
 * only through these: its Anthropic requests then go through the TeamClaude
 * account pool, not the owner's own account. An empty variable reads as
 * unset.
 */
export const proxyEnv: Effect.Effect<Readonly<Record<string, string>>> =
  callerVariables(PROXY_VARIABLES)

const wait = async (timeoutSeconds: number) => {
  const state = await readState()
  const deadline = Date.now() + timeoutSeconds * 1000
  let progress = WAIT_START
  let record: RunRecord = { started: false, open: [], stored: false }
  while (Date.now() < deadline) {
    const screen = await callHost(state, (host) => host.read({ scope: "screen" }))
    if (screen.exited !== undefined) {
      throw new Error(`gent exited ${screen.exited}; read --full shows its last screen`)
    }
    const text = screen.rows.slice(-12).join("\n")
    record = runRecordIn(state.data, state.sendMark)
    progress = waitStep(progress, text, record, state.awaitsTurn)
    if (isSettled(progress)) return
    await Bun.sleep(3000)
  }
  const turns = record.started
    ? `open turns: ${record.open.join(", ") || "none"}`
    : "no turn started"
  console.error(`not settled after ${timeoutSeconds}s; ${turns}`)
  process.exitCode = 1
}

const restart = async () => {
  const state = await readState()
  await callHost(state, (host) => host.restart({ command: [state.binary, "resume"] }))
  console.log("relaunched: gent resume")
}

/**
 * Stop the TUI and its host, then remove the run. A host that has stopped
 * already, or does not answer, is killed by its recorded process id once
 * `ps` shows it is still the host.
 */
const down = async () => {
  const state = await readState()
  const stopped = await Effect.runPromiseExit(
    hostCall(state.socket, (host) => host.down()).pipe(Effect.timeout("25 seconds")),
  )
  if (Exit.isSuccess(stopped) && stopped.value.killed) {
    console.log("gent did not quit on ctrl+c within 15s; killed it")
  }
  const deadline = Date.now() + 2000
  while ((await isHost(state.hostPid)) && Date.now() < deadline) await Bun.sleep(100)
  if (await isHost(state.hostPid)) process.kill(state.hostPid, "SIGKILL")
  await removeTree(state.root)
  rmSync(STATE_FILE, { force: true })
  console.log(`stopped the host, removed ${state.root}`)
}

/** The presets with each family resolved, as `up` would run them today. */
const list = async () => {
  const catalog = await loadCatalog()
  for (const [name, named] of Object.entries(PRESETS)) {
    const preset = resolvePreset(named, catalog)
    const format = (s: Slot) => `${s.modelId}:${s.reasoningEffort}`
    console.log(
      `${name.padEnd(14)} orchestrator ${format(preset.orchestrator).padEnd(34)} worker ${format(preset.worker).padEnd(34)} reviewer ${format(preset.reviewer)}`,
    )
  }
}

// ── entry ───────────────────────────────────────────────────────────────

const USAGE = `usage: bun run gamut <command>
  up <preset> [--prompt <file|text>] [--no-build]   fresh scratch run on its own terminal host
  send <text>                                       type text + Enter into the TUI
  keys <name…>                                      press named keys (ctrl+c, esc, down, tab, …)
  interrupt                                         press ctrl+c once
  read [--full]                                     print the rows added since the last read, or the screen
  wait [seconds]                                    block until the run is idle with no working child (default 600)
  status                                            sessions, models, prompts, tool calls, bun test
  restart                                           quit the TUI and resume the session
  down                                              quit, stop the host, remove the scratch dir
  list                                              presets`

/** `up`'s arguments. `--prompt` takes the next argument, which may not be a flag. */
export const parseUpArgs = (
  rest: ReadonlyArray<string>,
): { readonly preset: string; readonly prompt: string | undefined; readonly build: boolean } => {
  const promptIndex = rest.indexOf("--prompt")
  const prompt = promptIndex >= 0 ? rest[promptIndex + 1] : undefined
  if (promptIndex >= 0 && (prompt === undefined || prompt.startsWith("--"))) {
    throw new Error("--prompt needs a value: a file path or the prompt text")
  }
  const positional = rest.filter(
    (arg, index) => !arg.startsWith("--") && (promptIndex < 0 || index !== promptIndex + 1),
  )
  return { preset: positional[0] ?? "", prompt, build: !rest.includes("--no-build") }
}

const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [command, ...rest] = argv
  switch (command) {
    case "up": {
      const args = parseUpArgs(rest)
      return up(args.preset, args.prompt, args.build)
    }
    case "send":
      return send(rest.join(" "))
    case "keys":
      if (rest.length === 0) throw new Error("keys needs at least one key name")
      return pressKeys(rest)
    case "interrupt":
      return pressKeys(["ctrl+c"])
    case "read":
      return read(rest.includes("--full"))
    case "wait":
      return wait(parseCount("wait seconds", rest[0] ?? "600"))
    case "status":
      return status()
    case "restart":
      return restart()
    case "down":
      return down()
    case "list":
      return list()
    default:
      console.log(USAGE)
  }
}

/**
 * One line per failure. A failed git or bun call throws a `ShellError`
 * whose default print is a source frame and a stack; the reader needs the
 * exit code and what the command said.
 */
const failureLine = (error: unknown): string => {
  if (error instanceof $.ShellError) {
    const said = failureText(error.stdout.toString(), error.stderr.toString())
    return `gamut: a command failed (exit ${error.exitCode}): ${said}`
  }
  return `gamut: ${error instanceof Error ? error.message : String(error)}`
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(failureLine(error))
    process.exitCode = 1
  })
}
