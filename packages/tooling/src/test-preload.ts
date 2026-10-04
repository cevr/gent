/**
 * Defaults every gent test suite shares. Every `test` and `test:e2e` script
 * preloads this file, so the suites agree on them.
 *
 * - Logs are off: a test asserts on results, and a warning a test provokes on
 *   purpose is noise in the report.
 * - The per-test timeout is a backstop, not the bound. A test bounds itself
 *   with `Effect.timeout` inside the Effect, so its scope finalizers run when
 *   the bound fires; bun's own timeout abandons the fiber and skips them. With
 *   bun's 5 s default, a test that bounds itself at 8 or 20 s is cut off at
 *   5 s and its inner bound never runs. A test whose inner bound is 30 s or
 *   more passes its own, longer bun timeout. `setDefaultTimeout` below holds
 *   for each file of a `--parallel` run and for a one-file run; a plain
 *   multi-file run applies it to its first file only, so a plain lane also
 *   passes `--timeout=30000`, and the guards check that it does.
 * - Each test file has its own default data directory. `HOME` names a temp
 *   directory made here and removed in the `afterAll` below, and
 *   `GENT_DATA_DIR` is cleared, whatever the shell set. A `--parallel` run
 *   evaluates this file again for each test file, in a fresh global scope,
 *   and runs the `afterAll` after that file's last test; a plain run
 *   evaluates it once and runs the `afterAll` after the last file. So a home
 *   is removed once, after every test that uses it. Gent's data directory
 *   defaults to `<home>/.gent`, so a test that forgets to scope one (a spill
 *   file, a log, a registry) writes under the temp home, never into the real
 *   `~/.gent`. A test that needs a specific data directory still sets its
 *   own: a home it passes, or `GENT_DATA_DIR` through its config provider or
 *   a child process's environment.
 * - `GENT_MODEL_CATALOG_URL` names a closed local port: no test reaches
 *   models.dev, whatever root it builds.
 * - No test reaches the network. A request or connection to a host other
 *   than this machine is refused before it leaves the process, and the test
 *   it ran under fails. A test that needs a remote answer gives one: a
 *   fixture HTTP client, or the models.dev catalog fixture
 *   (`modelCatalogFixture`, `fixtureModelCatalog` or
 *   `serveModelCatalogFixture` from `@gent/core/test-utils`).
 *   Requests to `localhost`, `127.0.0.1` and `::1` pass, and so does a Unix
 *   socket: a test server runs there. A request to an address of this
 *   machine's own interfaces (`os.networkInterfaces`, read once as this file
 *   loads) passes too: the kernel delivers it on this machine, and a test
 *   that proves a listener refuses peers on a LAN or tailnet address sends
 *   one. The guard holds every entry point it
 *   can replace: `fetch` and `fetch.preconnect`; the `node:net` socket's
 *   `connect`, which `net.connect`, `tls.connect`, `http2.connect` and the
 *   agents of `node:http` and `node:https` call; `WebSocket`; and
 *   `Bun.connect`, which the `bun` module's `connect` export reads.
 *   `Bun.fetch` is a read-only property
 *   that no preload can replace, so the lint config bans it, and the `bun`
 *   module's `fetch` export, in test code. Effect's `FetchHttpClient.Fetch`
 *   reads `globalThis.fetch` once, the first time a fiber reads it: bun runs
 *   this file before it loads any test module, so the first read gets the
 *   guard.
 */
import { afterAll, afterEach, expect, mock, setDefaultTimeout } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { Socket } from "node:net"
import * as os from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Option, Predicate, References, Schema } from "effect"

/** Longer than every inner `Effect.timeout` a test sets without its own bun timeout. */
const TEST_TIMEOUT_BACKSTOP_MS = 30_000

setDefaultTimeout(TEST_TIMEOUT_BACKSTOP_MS)

Reflect.defineProperty(References.MinimumLogLevel, "defaultValue", {
  value: () => "None",
})

const testHome = mkdtempSync(join(tmpdir(), "gent-test-home-"))
// A child process reads HOME as it starts. This process's `homedir()` read it
// before this file ran, so the `os` module answers for it, under both names.
// oxlint-disable-next-line effect/noGlobals -- the preload sets the test process's environment before any Effect runtime
Bun.env["HOME"] = testHome
// oxlint-disable-next-line effect/noGlobals -- the preload sets the test process's environment before any Effect runtime
Reflect.deleteProperty(Bun.env, "GENT_DATA_DIR")
// A server a test starts without the fixture client (an SDK `Gent.server`, a
// child process) fetches the models.dev catalog from a closed local port: its
// first read fails at once, and the catalog reports itself unavailable.
// oxlint-disable-next-line effect/noGlobals -- the preload sets the test process's environment before any Effect runtime
Bun.env["GENT_MODEL_CATALOG_URL"] = "http://127.0.0.1:9"
const osWithTestHome = { ...os, homedir: () => testHome }
for (const specifier of ["node:os", "os"]) {
  void mock.module(specifier, () => ({ ...osWithTestHome, default: osWithTestHome }))
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }))

// ── network guard ───────────────────────────────────────────────────────────

/** Loopback names and the addresses of this machine's own interfaces. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  ...Object.values(os.networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).map((address) => address.address),
  ),
])
/** The remote targets the running test tried to reach. */
const refusedRequests: Array<string> = []

/** True for a loopback name or an address of this machine, bracketed or not. */
const isThisMachine = (host: string): boolean => LOCAL_HOSTS.has(host.replace(/^\[(.*)\]$/u, "$1"))

/** Records a refused target and makes the failure its entry point raises. */
const refusal = (target: string): Error => {
  refusedRequests.push(target)
  return new Error(`the test preload refuses a network request: ${target}`)
}

/** `args` as given when `target` finds no remote host in them; a throw otherwise. */
const admit = <A extends ReadonlyArray<unknown>>(
  args: A,
  target: (args: A) => Option.Option<string>,
): A =>
  Option.match(target(args), {
    onNone: () => args,
    onSome: (remote) => {
      throw refusal(remote)
    },
  })

/** The remote URL `url` names; none for this machine. */
const remoteUrl = (url: string | URL): Option.Option<string> => {
  const parsed = new URL(url)
  return Option.liftPredicate(parsed.href, () => !isThisMachine(parsed.hostname))
}

/** The fields of a `node:net` socket's or `Bun.connect`'s options that name the peer. */
const PeerOptions = Schema.Struct({
  hostname: Schema.optional(Schema.NullOr(Schema.String)),
  host: Schema.optional(Schema.NullOr(Schema.String)),
  port: Schema.optional(Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]))),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  unix: Schema.optional(Schema.String),
})
type PeerOptions = typeof PeerOptions.Type
const peerOptions = Schema.decodeUnknownOption(PeerOptions)

/**
 * The remote `tcp://host:port` the options name; none for this machine or a
 * Unix socket. A `path` names a Unix socket only with no port: a Node request
 * hands its socket the URL path too.
 */
const remotePeer = (options: PeerOptions): Option.Option<string> => {
  const port = Option.fromNullishOr(options.port)
  if (Predicate.isString(options.unix)) return Option.none()
  if (Predicate.isString(options.path) && Option.isNone(port)) return Option.none()
  const host = Option.getOrElse(
    Option.firstSomeOf([
      Option.fromNullishOr(options.hostname),
      Option.fromNullishOr(options.host),
    ]),
    () => "localhost",
  )
  const portSuffix = Option.match(port, { onNone: () => "", onSome: (value) => `:${value}` })
  return Option.liftPredicate(`tcp://${host}${portSuffix}`, () => !isThisMachine(host))
}

// `fetch` and its `preconnect`, which `FetchHttpClient` and every fetch-based
// SDK reach through `globalThis.fetch`.
const passedFetch = globalThis.fetch
const guardedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  Option.match(remoteUrl(new Request(input).url), {
    // oxlint-disable-next-line effect/noGlobals -- the guard is fetch: a loopback request goes on to the real one
    onNone: () => passedFetch(input, init),
    // fetch's own failure shape: a rejected promise with an Error
    onSome: (remote) => Promise.reject(refusal(remote)),
  })
const guardedPreconnect = (...args: Parameters<typeof passedFetch.preconnect>): void =>
  passedFetch.preconnect(...admit(args, ([url]) => remoteUrl(url)))
globalThis.fetch = Object.assign(guardedFetch, { preconnect: guardedPreconnect })

// The `node:net` socket's `connect`. `net.connect`, `net.createConnection`,
// `tls.connect` and `http2.connect` open their socket through it, and so do
// the agents of `node:http` and `node:https`: every Node client request.
/** The remote target of `connect(options, cb?)`, `connect(port, host?, cb?)` or `connect(path, cb?)`. */
const remoteSocket = (args: ReadonlyArray<unknown>): Option.Option<string> => {
  // `net.connect` hands the socket its arguments normalized as one `[options, cb]` array.
  const [first, second] = Option.getOrElse(
    Option.liftPredicate(args[0], (value): value is ReadonlyArray<unknown> => Arr.isArray(value)),
    (): ReadonlyArray<unknown> => args,
  )
  if (Predicate.isNumber(first) || (Predicate.isString(first) && /^\d+$/u.test(first))) {
    const host = Option.getOrElse(
      Option.liftPredicate(second, Predicate.isString),
      () => "localhost",
    )
    return remotePeer({ host, port: first })
  }
  // A string that is not a port is a Unix socket path.
  if (Predicate.isString(first)) return Option.none()
  return Option.flatMap(peerOptions(first), remotePeer)
}
const passedConnect = Socket.prototype.connect
Object.assign(Socket.prototype, {
  connect(this: Socket, ...args: ReadonlyArray<unknown>) {
    return Reflect.apply(passedConnect, this, admit(args, remoteSocket))
  },
})

// `WebSocket`.
const PassedWebSocket = globalThis.WebSocket
globalThis.WebSocket = class GuardedWebSocket extends PassedWebSocket {
  constructor(...args: ConstructorParameters<typeof PassedWebSocket>) {
    super(...admit(args, ([url]) => remoteUrl(url)))
  }
}

// `Bun.connect`, which the `bun` module's `connect` export reads too.
// oxlint-disable-next-line effect/noGlobals -- the guard is Bun.connect: a loopback connection goes on to the real one
const passedBunConnect = Bun.connect
Reflect.set(Bun, "connect", (...args: Parameters<typeof passedBunConnect>) =>
  Option.match(Option.flatMap(peerOptions(args[0]), remotePeer), {
    onNone: () => Reflect.apply(passedBunConnect, Bun, args),
    onSome: (remote) => Promise.reject(refusal(remote)),
  }),
)

afterEach(() => {
  expect(refusedRequests.splice(0)).toEqual([])
})
