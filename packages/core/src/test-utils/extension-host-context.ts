import { Effect, FileSystem, Option, Random } from "effect"
import { ExtensionHostProcessError, type ExtensionHostPlatform } from "../domain/extension.js"
import {
  ExtensionServiceError,
  type ExtensionFileLockServiceApi,
  type ExtensionFilesService,
  type ExtensionHostAgentService,
  type ExtensionHostContext,
  type ExtensionInteractionService,
  type ExtensionProcessService,
  type ExtensionSessionService,
  type ExtensionStateFacet,
} from "../domain/extension-services.js"
import { makeFileWriter } from "../domain/file-writer.js"
import { BranchId, SessionId } from "../domain/ids.js"

type TestExtensionHostContextOverrides = Omit<
  Partial<ExtensionHostContext>,
  "Agent" | "Session" | "Interaction"
> & {
  readonly Agent?: Partial<ExtensionHostAgentService>
  readonly Session?: Partial<ExtensionSessionService>
  readonly Interaction?: Partial<ExtensionInteractionService>
}

const die = (operation: string) =>
  Effect.die(new Error(`unconfigured test ExtensionHostContext.${operation}`))

const defaultAgent = (): ExtensionHostAgentService => ({
  listAgents: die("Agent.listAgents"),
  start: () => die("Agent.start"),
  inspect: () => die("Agent.inspect"),
  list: () => die("Agent.list"),
  cancel: () => die("Agent.cancel"),
  run: () => die("Agent.run"),
})

const defaultSession = (): ExtensionSessionService => ({
  getSession: () => die("Session.getSession"),
  getDetail: () => die("Session.getDetail"),
  renameCurrent: () => die("Session.renameCurrent"),
  search: () => die("Session.search"),
  queueFollowUp: () => die("Session.queueFollowUp"),
  dequeueFollowUp: () => die("Session.dequeueFollowUp"),
  listBranches: die("Session.listBranches"),
  listSessions: die("Session.listSessions"),
  listActiveLoops: die("Session.listActiveLoops"),
})

const defaultInteraction = (): ExtensionInteractionService => ({
  approve: () => die("Interaction.approve"),
  present: () => die("Interaction.present"),
})

/** The one host platform stub: a darwin box whose `runProcess` is unavailable. */
export const testExtensionHostPlatform = (home: string = "/tmp"): ExtensionHostPlatform => ({
  osInfo: {
    platform: "darwin",
    arch: "arm64",
    release: "test",
    hostname: "test-host",
    type: "Darwin",
  },
  execPath: "/usr/bin/node",
  homeDirectory: home,
  parentEnv: {},
  randomId: Random.nextInt.pipe(Effect.map((value) => `test-${value}`)),
  pathListSeparator: ":",
  runProcess: (command) =>
    Effect.fail(
      new ExtensionHostProcessError({
        command,
        message: "test host runProcess unavailable",
      }),
    ),
})

const filesError = (operation: string) => (cause: unknown) => {
  let message = String(cause)
  if (cause instanceof Error) message = cause.message
  return new ExtensionServiceError({ service: "ExtensionFiles", operation, message, cause })
}

/**
 * Posix path helpers, spelled out so the stub needs neither a node import nor
 * a snapshot of the platform service. Tests run on posix paths only.
 */
const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment.length > 0 && segment !== ".")

const normalize = (segments: ReadonlyArray<string>): ReadonlyArray<string> =>
  segments.reduce<ReadonlyArray<string>>((kept, segment) => {
    if (segment !== "..") return [...kept, segment]
    return kept.slice(0, Math.max(0, kept.length - 1))
  }, [])

const posixJoin = (...paths: ReadonlyArray<string>): string => {
  const joined = normalize(paths.flatMap(segmentsOf)).join("/")
  const rooted = paths.some((path, index) => index === 0 && path.startsWith("/"))
  if (rooted) return `/${joined}`
  if (joined.length === 0) return "."
  return joined
}

const posixResolve = (...paths: ReadonlyArray<string>): string => {
  const lastAbsolute = paths.findLastIndex((path) => path.startsWith("/"))
  if (lastAbsolute < 0) return posixJoin("/", ...paths)
  return posixJoin(...paths.slice(lastAbsolute))
}

const posixDirname = (path: string): string => {
  const cut = path.lastIndexOf("/")
  if (cut < 0) return "."
  if (cut === 0) return "/"
  return path.slice(0, cut)
}

/** Runs against the ambient file system, or reports its absence. */
const onFileSystem = <A, E>(
  operation: string,
  use: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>,
): Effect.Effect<A, ExtensionServiceError> =>
  Effect.serviceOption(FileSystem.FileSystem).pipe(
    Effect.flatMap((service) =>
      Option.match(service, {
        onNone: () => Effect.fail(filesError(operation)("FileSystem service unavailable in test")),
        onSome: (fs) => use(fs).pipe(Effect.mapError(filesError(operation))),
      }),
    ),
  )

export const testExtensionFiles = (): ExtensionFilesService => ({
  read: (path) => onFileSystem("read", (fs) => fs.readFileString(path)),
  write: (path, content, options) =>
    onFileSystem("write", (fs) => makeFileWriter(fs, posixDirname)(path, content, options)),
  exists: (path) => onFileSystem("exists", (fs) => fs.exists(path)),
  stat: (path) =>
    onFileSystem("stat", (fs) =>
      fs.stat(path).pipe(
        Effect.map((info) => ({
          type: info.type,
          size: info.size,
          mtime: Option.getOrUndefined(info.mtime),
        })),
      ),
    ),
  makeDirectory: (path, options) =>
    onFileSystem("makeDirectory", (fs) => fs.makeDirectory(path, options)),
  rename: (from, to) => onFileSystem("rename", (fs) => fs.rename(from, to)),
  resolve: (...paths) => posixResolve(...paths),
  join: (...paths) => posixJoin(...paths),
  dirname: (path) => posixDirname(path),
})

export const testExtensionProcess = (host: ExtensionHostPlatform): ExtensionProcessService => ({
  randomId: host.randomId,
  run: (command, args, options) =>
    host.runProcess(command, args, options).pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionServiceError({
            service: "ExtensionProcess",
            operation: "run",
            message: cause.message,
            cause,
          }),
      ),
    ),
  parentEnv: host.parentEnv,
})

export const testExtensionFileLock = (): ExtensionFileLockServiceApi => ({
  withLock: (_path, effect) => effect,
})

export const testExtensionState = (): ReturnType<ExtensionStateFacet> => ({
  changed: () => Effect.void,
})

export const testExtensionHostContext = (
  overrides: TestExtensionHostContextOverrides = {},
): ExtensionHostContext => ({
  sessionId: overrides.sessionId ?? SessionId.make("test-session"),
  branchId: overrides.branchId ?? BranchId.make("test-branch"),
  cwd: overrides.cwd ?? "/tmp",
  home: overrides.home ?? "/tmp",
  host: overrides.host ?? testExtensionHostPlatform(overrides.home),
  agentName: overrides.agentName,
  Agent: { ...defaultAgent(), ...overrides.Agent },
  Session: { ...defaultSession(), ...overrides.Session },
  Interaction: { ...defaultInteraction(), ...overrides.Interaction },
  Process:
    overrides.Process ??
    testExtensionProcess(overrides.host ?? testExtensionHostPlatform(overrides.home)),
  Files: overrides.Files ?? testExtensionFiles(),
  FileLock: overrides.FileLock ?? testExtensionFileLock(),
  State: overrides.State ?? (() => testExtensionState()),
})
