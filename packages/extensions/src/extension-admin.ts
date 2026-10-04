import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionStatus,
  hasProjectScope,
  isProjectTrusted,
  resolveDataDir,
  tool,
  writeFileAtomic,
} from "@gent/core/extensions/api"

// The agent's hands on the extensions of its session: see which loaded, turn
// one off or on, add one, remove one, and set them up again. Every change
// lands in a file the next turn reads (a config's `disabledExtensions`, an
// extensions directory), so it reaches the next turn of every session in its
// scope and no running turn. A verb that changes what the next turn loads asks
// the user once; a headless run declines. Every verb uses only the public
// `ExtensionContext` and the Effect platform services, so a user extension
// could ship the same ones.

const EXTENSION_ADMIN_EXTENSION_ID = "@gent/extension-admin"

// ── scope ───────────────────────────────────────────────────────────────────

const AdminScope = Schema.Literals(["user", "project"])
type AdminScope = typeof AdminScope.Type

/** A verb that cannot run as asked; the message says what would let it. */
class ExtensionAdminRefused extends Schema.TaggedError<ExtensionAdminRefused>()(
  "ExtensionAdminRefused",
  { message: Schema.String },
) {}

const refuse = (message: string) => new ExtensionAdminRefused({ message })

/** Where one scope's extensions and config live, and who a change there reaches. */
interface ScopePlace {
  readonly scope: AdminScope
  readonly extensionsDir: string
  readonly configPath: string
  readonly reach: string
}

/**
 * The scope a verb writes to. `user` is the default only when the session
 * runs from home, where there is no project scope. `project` needs a project
 * the user trusts: trust is the user's own step, never a verb.
 */
const scopePlace = Effect.fn("ExtensionAdmin.scopePlace")(function* (
  requested: Option.Option<AdminScope>,
) {
  const ctx = yield* ExtensionContext
  const path = yield* Path.Path
  const projectScope = yield* hasProjectScope({ user: ctx.home, project: ctx.cwd })
  if (Option.isNone(requested) && projectScope) {
    return yield* refuse(
      "Name the scope: `user` reaches every project on this server, `project` only this one.",
    )
  }
  const scope = Option.getOrElse(requested, (): AdminScope => "user")
  if (scope === "user") {
    const root = path.join(ctx.home, ".gent")
    return {
      scope,
      extensionsDir: path.join(root, "extensions"),
      configPath: path.join(root, "config.json"),
      reach: "user scope: every project on this server, from each session's next turn",
    } satisfies ScopePlace
  }
  const projectRoot = path.resolve(ctx.cwd)
  if (!projectScope) {
    return yield* refuse(
      "This session runs from the home directory, so there is no project scope. Use `user`.",
    )
  }
  if (!(yield* isProjectTrusted({ home: ctx.home, cwd: ctx.cwd }))) {
    return yield* refuse(
      `The project ${projectRoot} is not trusted, so its extensions do not load. The user trusts it by adding its canonical root to \`trustedProjects\` in ~/.gent/config.json; an agent cannot.`,
    )
  }
  const root = path.join(projectRoot, ".gent")
  return {
    scope,
    extensionsDir: path.join(root, "extensions"),
    configPath: path.join(root, "config.json"),
    reach: `project scope: every session in ${projectRoot}, from its next turn`,
  } satisfies ScopePlace
})

// ── config ──────────────────────────────────────────────────────────────────

const RawConfigJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeDisabled = Schema.decodeUnknownEffect(Schema.Array(Schema.String))

/**
 * A config file as it is now: every key, and its `disabledExtensions`. A file
 * that does not decode is refused, never replaced: a hand edit is the user's.
 */
const readConfig = Effect.fn("ExtensionAdmin.readConfig")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem
  const broken = (reason: string) =>
    refuse(`${configPath} does not decode, so it is left as it is (${reason}). Fix it first.`)
  if (!(yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false)))) {
    return { raw: {}, disabled: [] }
  }
  const text = yield* fs
    .readFileString(configPath)
    .pipe(Effect.mapError((error) => broken(error.message)))
  const raw = yield* Schema.decodeEffect(RawConfigJson)(text).pipe(
    Effect.mapError((error) => broken(error.message)),
  )
  const disabled = yield* Option.match(Option.fromUndefinedOr(raw["disabledExtensions"]), {
    onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
    onSome: (value) =>
      decodeDisabled(value).pipe(Effect.mapError((error) => broken(error.message))),
  })
  return { raw, disabled }
})

/** Rewrite one scope's `disabledExtensions` under the file's lock; every other key stays. */
const updateDisabled = (
  configPath: string,
  update: (disabled: ReadonlyArray<string>) => ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* ctx.FileLock.withLock(
      configPath,
      Effect.gen(function* () {
        const { raw, disabled } = yield* readConfig(configPath)
        yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
        const text = yield* Schema.encodeEffect(RawConfigJson)({
          ...raw,
          disabledExtensions: update(disabled),
        })
        yield* writeFileAtomic(configPath, `${text}\n`)
      }),
    )
  })

// ── shared verb steps ───────────────────────────────────────────────────────

const VerbOutput = Schema.Struct({
  applied: Schema.Boolean.annotate({
    description:
      "True when the change was made; false when there was nothing to do or the user declined.",
  }),
  detail: Schema.String.annotate({ description: "What was done, or why not." }),
  resumeQueued: Schema.Boolean.annotate({
    description: "True when the `resume` message was queued as your next turn.",
  }),
  extensions: Schema.Array(ExtensionStatus).annotate({
    description: "Every extension of the session after the change, as `extensions.status` lists.",
  }),
})
type VerbOutput = typeof VerbOutput.Type

const ResumeParam = Schema.optionalKey(
  Schema.String.annotate({
    description:
      "A message to queue as your next turn once the change is made, so you can use the changed extensions in this same task. Leave it out to stop after the change.",
  }),
)

/**
 * Ask the user once. The answer is kept for the call, so the tool that runs
 * again after the ask takes it and asks nothing more.
 */
const ask = (verb: string, text: string, place: ScopePlace, target: string) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const decision = yield* ctx.Interaction.approve({
      text,
      metadata: { type: EXTENSION_ADMIN_EXTENSION_ID, verb, scope: place.scope, path: target },
    })
    return decision.approved
  })

/**
 * The outcome of a verb: the statuses as they are now and, when the change
 * was made and the model asked for it, one queued follow-up on its own
 * branch. The follow-up runs after this turn, on the profile the change made.
 */
const finish = (
  verb: string,
  applied: boolean,
  detail: string,
  resume: Option.Option<string>,
): Effect.Effect<VerbOutput, never, ExtensionContext> =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const extensions = yield* ctx.Extensions.status.pipe(
      Effect.orElseSucceed((): ReadonlyArray<ExtensionStatus> => []),
    )
    let resumeQueued = false
    if (applied && Option.isSome(resume)) {
      const call = Option.getOrElse(Option.fromUndefinedOr(ctx.toolCallId), () => verb)
      resumeQueued = yield* ctx.Session.send({
        delivery: "queue",
        content: resume.value,
        sourceId: `${EXTENSION_ADMIN_EXTENSION_ID}:resume:${call}`,
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    }
    return { applied, detail, resumeQueued, extensions }
  })

const DECLINED = "The user declined: nothing changed."

// ── status ──────────────────────────────────────────────────────────────────

const ExtensionsStatusTool = tool({
  id: "extensions.status",
  readonly: true,
  description:
    "List the extensions of this session: each one's id, scope, source file and state. `Active` names the version it loaded; with `reloadFailed` it is the last good version, still running because a newer version of its file failed at that phase. `Failed` names the phase that stopped it (`load`: the file did not build or import; `setup`; `validation`; `startup`: a Resource did not build) and the error; `Disabled` is named by a config's `disabledExtensions`. It loads the extension files as they are now, so call it after you write or edit one to see whether it loads. The next turn uses what it reports.",
  promptSnippet: "List the session's extensions and whether each loaded",
  params: Schema.Struct({
    id: Schema.optionalKey(
      Schema.String.annotate({ description: "Report only the extension with this id." }),
    ),
  }),
  output: Schema.Struct({ extensions: Schema.Array(ExtensionStatus) }),
  execute: (params) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const all = yield* ctx.Extensions.status
      const target = Option.fromUndefinedOr(params.id)
      const extensions = all.filter((status) =>
        Option.match(target, { onNone: () => true, onSome: (id) => status.id === id }),
      )
      return { extensions }
    }),
})

// ── enable / disable ────────────────────────────────────────────────────────

const ScopeParam = Schema.optionalKey(
  AdminScope.annotate({
    description:
      "Whose config or directory: `user` (~/.gent, every project) or `project` (<cwd>/.gent, a trusted project only). Required outside the home directory.",
  }),
)

const ToggleParams = Schema.Struct({
  id: Schema.String.annotate({ description: "The extension id, as `extensions.status` lists it." }),
  scope: ScopeParam,
  resume: ResumeParam,
})

const TOGGLE = {
  disable: { action: "Turn off", done: "Disabled" },
  enable: { action: "Turn on", done: "Enabled" },
}

/**
 * Add an id to, or take it from, one scope's `disabledExtensions`. The other
 * scope's list stays: an id either list names stays disabled.
 */
const toggle = (verb: "enable" | "disable", params: typeof ToggleParams.Type) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const place = yield* scopePlace(Option.fromUndefinedOr(params.scope))
    const resume = Option.fromUndefinedOr(params.resume)
    const { disabled } = yield* readConfig(place.configPath)
    const listed = disabled.includes(params.id)
    if (verb === "disable" && listed) {
      const detail = `${place.configPath} disables ${params.id} already.`
      return yield* finish(verb, false, detail, resume)
    }
    if (verb === "enable" && !listed) {
      const detail = `${place.configPath} does not disable ${params.id}. An id the other scope's config names stays disabled: enable it in that scope.`
      return yield* finish(verb, false, detail, resume)
    }
    if (verb === "disable") {
      const known = (yield* ctx.Extensions.status).some((status) => status.id === params.id)
      if (!known) {
        return yield* refuse(
          `No extension of this session has the id ${params.id}; \`extensions.status\` lists them.`,
        )
      }
    }
    const approved = yield* ask(
      verb,
      `${TOGGLE[verb].action} the extension "${params.id}" in the ${place.reach}. This edits disabledExtensions in ${place.configPath}.`,
      place,
      place.configPath,
    )
    if (!approved) return yield* finish(verb, false, DECLINED, resume)
    yield* updateDisabled(place.configPath, (current) => {
      if (verb === "disable") return [...new Set([...current, params.id])]
      return current.filter((id) => id !== params.id)
    })
    const detail = `${TOGGLE[verb].done} ${params.id} in ${place.configPath}: the ${place.reach}.`
    return yield* finish(verb, true, detail, resume)
  })

const toggleDescription = (verb: "enable" | "disable") =>
  `${TOGGLE[verb].action} an extension by id in one scope's config (\`disabledExtensions\`). It asks the user once; a headless run declines. The change reaches the next turn of every session in the scope, not the running one: pass \`resume\` to continue on it. Returns the statuses after the change.`

const ExtensionsDisableTool = tool({
  id: "extensions.disable",
  description: toggleDescription("disable"),
  promptSnippet: "Turn off an extension in the user or project config",
  params: ToggleParams,
  output: VerbOutput,
  execute: (params) => toggle("disable", params),
})

const ExtensionsEnableTool = tool({
  id: "extensions.enable",
  description: toggleDescription("enable"),
  promptSnippet: "Turn on an extension the user or project config disables",
  params: ToggleParams,
  output: VerbOutput,
  execute: (params) => toggle("enable", params),
})

// ── add ─────────────────────────────────────────────────────────────────────

const EXTENSION_FILE = /\.(?:[tj]sx?|mjs)$/
const INDEX_FILES = ["index.ts", "index.js", "index.mjs"]

const AddParams = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "The extension to add: a .ts, .js or .mjs file, or a directory with an index file. A relative path resolves against the session's directory.",
  }),
  scope: ScopeParam,
  resume: ResumeParam,
})

const ExtensionsAddTool = tool({
  id: "extensions.add",
  description:
    "Copy an extension file or directory into one scope's extensions directory (~/.gent/extensions or <cwd>/.gent/extensions). A name that exists there is refused: edit that extension in place instead. It asks the user once; a headless run declines. The next turn of every session in the scope loads it: pass `resume` to continue on it. Returns the statuses after the change.",
  promptSnippet: "Add an extension file or directory to the user or project scope",
  params: AddParams,
  output: VerbOutput,
  execute: (params) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const place = yield* scopePlace(Option.fromUndefinedOr(params.scope))
      const resume = Option.fromUndefinedOr(params.resume)
      const source = path.resolve(ctx.cwd, params.path)
      const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))
      const info = yield* fs
        .stat(source)
        .pipe(Effect.mapError((error) => refuse(`${source} cannot be read: ${error.message}`)))
      if (info.type === "File" && !EXTENSION_FILE.test(source)) {
        return yield* refuse(`${source} is not a .ts, .js or .mjs file.`)
      }
      if (info.type === "Directory") {
        let index = false
        for (const name of INDEX_FILES) if (yield* exists(path.join(source, name))) index = true
        if (!index) return yield* refuse(`${source} has no index.ts, index.js or index.mjs.`)
      } else if (info.type !== "File") {
        return yield* refuse(`${source} is neither a file nor a directory.`)
      }
      const target = path.join(place.extensionsDir, path.basename(source))
      const taken = refuse(`${target} exists. Edit that extension in place, or remove it first.`)
      if (yield* exists(target)) return yield* taken
      const approved = yield* ask(
        "add",
        `Add the extension ${source} to the ${place.reach}. This copies it to ${target}.`,
        place,
        target,
      )
      if (!approved) return yield* finish("add", false, DECLINED, resume)
      yield* ctx.FileLock.withLock(
        target,
        Effect.gen(function* () {
          if (yield* exists(target)) return yield* taken
          yield* fs.makeDirectory(place.extensionsDir, { recursive: true })
          // A hidden sibling is never scanned, so the extension appears whole.
          const staging = path.join(
            place.extensionsDir,
            `.adding-${String(yield* Clock.currentTimeMillis)}-${path.basename(source)}`,
          )
          yield* fs.copy(source, staging).pipe(
            Effect.andThen(fs.rename(staging, target)),
            Effect.onError(() => fs.remove(staging, { recursive: true }).pipe(Effect.ignore)),
          )
        }),
      )
      return yield* finish("add", true, `Added ${target}: the ${place.reach}.`, resume)
    }),
})

// ── remove ──────────────────────────────────────────────────────────────────

const RemoveParams = Schema.Struct({
  id: ToggleParams.fields.id,
  scope: Schema.optionalKey(
    AdminScope.annotate({
      description: "The scope the extension lives in, when both scopes have one with this id.",
    }),
  ),
  resume: ResumeParam,
})

const ExtensionsRemoveTool = tool({
  id: "extensions.remove",
  description:
    "Remove a user or project extension: move its file or directory out of the extensions directory into gent's data directory (extension-trash), where the user can get it back. A shipped extension cannot be removed; disable it instead. It asks the user once; a headless run declines. The next turn of every session in the scope no longer has it: pass `resume` to continue. Returns the statuses after the change.",
  promptSnippet: "Remove a user or project extension (moved to the trash)",
  params: RemoveParams,
  output: VerbOutput,
  execute: (params) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const resume = Option.fromUndefinedOr(params.resume)
      const requested = Option.fromUndefinedOr(params.scope)
      const named = (yield* ctx.Extensions.status).filter((status) => status.id === params.id)
      const candidates = named.filter(
        (status) =>
          status.scope !== "builtin" &&
          Option.match(requested, {
            onNone: () => true,
            onSome: (scope) => status.scope === scope,
          }),
      )
      if (candidates.length > 1)
        return yield* refuse(`Both scopes have ${params.id}. Name the scope.`)
      const found = Option.fromNullishOr(candidates[0])
      if (Option.isNone(found) || found.value.scope === "builtin") {
        if (named.some((status) => status.scope === "builtin")) {
          return yield* refuse(`${params.id} ships with gent; disable it instead.`)
        }
        return yield* refuse(
          `No user or project extension has the id ${params.id}; \`extensions.status\` lists them.`,
        )
      }
      const place = yield* scopePlace(Option.some(found.value.scope))
      // The extension's own file, or the directory its index is in. Anything
      // else (a config file that did not load) is not an extension to move.
      const sourcePath = found.value.sourcePath
      let target = sourcePath
      const parent = path.dirname(sourcePath)
      if (parent !== place.extensionsDir) {
        const isIndex = INDEX_FILES.includes(path.basename(sourcePath))
        if (!isIndex || path.dirname(parent) !== place.extensionsDir) {
          return yield* refuse(`${sourcePath} is not in ${place.extensionsDir}.`)
        }
        target = parent
      }
      const trash = path.join(yield* resolveDataDir(ctx.home), "extension-trash")
      const approved = yield* ask(
        "remove",
        `Remove the extension "${params.id}" from the ${place.reach}. This moves ${target} to ${trash}.`,
        place,
        target,
      )
      if (!approved) return yield* finish("remove", false, DECLINED, resume)
      const destination = path.join(
        trash,
        `${String(yield* Clock.currentTimeMillis)}-${path.basename(target)}`,
      )
      yield* ctx.FileLock.withLock(
        target,
        Effect.gen(function* () {
          yield* fs.makeDirectory(trash, { recursive: true })
          // Another file system cannot take a rename: copy, then delete.
          yield* fs
            .rename(target, destination)
            .pipe(
              Effect.catch(() =>
                fs
                  .copy(target, destination)
                  .pipe(Effect.andThen(fs.remove(target, { recursive: true }))),
              ),
            )
        }),
      )
      const detail = `Moved ${target} to ${destination}: the ${place.reach}.`
      return yield* finish("remove", true, detail, resume)
    }),
})

// ── reload ──────────────────────────────────────────────────────────────────

const ExtensionsReloadTool = tool({
  id: "extensions.reload",
  description:
    "Set up the extensions of this session again over the same files, without asking: the code does not change. An unchanged extension keeps its Resources and their state. Use it when an extension reads something outside its files at setup. A file edit needs no reload: the next turn loads it. Pass `resume` to continue on the new setup. Returns the statuses after the reload.",
  promptSnippet: "Set up the session's extensions again",
  params: Schema.Struct({
    id: Schema.String.annotate({ description: "An extension id the session has." }),
    resume: ResumeParam,
  }),
  output: VerbOutput,
  execute: (params) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      yield* ctx.Extensions.reload(params.id)
      const detail = `Set ${params.id} up again; the next turn runs the new setup.`
      return yield* finish("reload", true, detail, Option.fromUndefinedOr(params.resume))
    }),
})

export const ExtensionAdminExtension = defineExtension({
  id: EXTENSION_ADMIN_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ExtensionsStatusTool)
    yield* host.register("tool", ExtensionsEnableTool)
    yield* host.register("tool", ExtensionsDisableTool)
    yield* host.register("tool", ExtensionsAddTool)
    yield* host.register("tool", ExtensionsRemoveTool)
    yield* host.register("tool", ExtensionsReloadTool)
  }),
})
