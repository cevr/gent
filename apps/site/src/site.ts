/**
 * gent.cvr.im: the site's HTTP surface. The Railway service
 * (`src/deploy.ts`) and the tests mount this one layer.
 *
 * - `GET /` is the landing page: what gent is, the install line, links.
 * - `GET /install.sh` and `GET /install` serve the installer itself, never a
 *   redirect, so `curl -fsSL https://gent.cvr.im/install.sh | sh` runs it.
 *   Use HTTPS: Railway's edge answers plain HTTP with an empty 301 before the
 *   request reaches this app, so `curl gent.cvr.im/install.sh | sh` without
 *   `-L` runs nothing. The script is the `install.sh` asset of the latest
 *   GitHub release, when GitHub answers with a complete installer. When there
 *   is no release, or GitHub fails or answers with anything else, it is the
 *   copy bundled at deploy time; with no copy, a script that says so and exits
 *   1. The `x-gent-install-source` header names which one answered.
 * - `GET /healthz` answers `ok` (Railway's health check).
 */
import { Cache, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/http"

// ── Constants ────────────────────────────────────────────────────────────────

export const REPO_URL = "https://github.com/cevr/gent"
export const RELEASES_URL = `${REPO_URL}/releases`
/** GitHub redirects this to the asset of the newest published release. */
export const RELEASE_INSTALLER_URL = `${RELEASES_URL}/latest/download/install.sh`
export const INSTALL_LINE = "curl -fsSL https://gent.cvr.im/install.sh | sh"

/** How long a release script is served before GitHub is asked again. */
const RELEASE_TTL = Duration.minutes(5)
/** After a miss (no release, or GitHub failed), ask again sooner. */
const MISS_TTL = Duration.minutes(1)
const FETCH_TIMEOUT = Duration.seconds(10)

/**
 * The hosts a release download may pass through: GitHub itself, then the
 * hosts it redirects release assets to. Every hop is HTTPS on the default port.
 */
const RELEASE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
])
/** GitHub takes two hops (tag, then asset host); more is not a release download. */
const MAX_REDIRECTS = 5
/** The installer is about 11 KiB; anything this large is not it. */
export const MAX_INSTALLER_BYTES = 256 * 1024
/** The second line of the repo's `install.sh`: what makes a script gent's installer. */
export const INSTALLER_MARKER =
  "# Install gent, the minimal agent harness: https://github.com/cevr/gent"
/** The installer's last line. Its body is inside `main`, so a cut-short copy runs nothing. */
const INSTALLER_CALL = 'main "$@"'

/**
 * The script for when no installer exists. Served with status 200: a 4xx or
 * 5xx makes `curl -f` print nothing, and `sh` then exits 0 on empty input.
 */
export const NO_RELEASE_SCRIPT = `#!/bin/sh
echo "gent: no release yet. Watch ${RELEASES_URL}" >&2
exit 1
`

// ── Install script ───────────────────────────────────────────────────────────

/** Which copy of the installer answered. */
export type InstallSource = "release" | "bundled" | "none"

/** Options for the site: the installer copy the deploy bundled, if any. */
export interface SiteOptions {
  readonly bundledInstaller: Option.Option<string>
}

/** Why a release answer is not served as the installer. */
export class InstallerRejected extends Schema.TaggedError<InstallerRejected>()(
  "InstallerRejected",
  { reason: Schema.String },
) {}

const reject = (reason: string): Effect.Effect<never, InstallerRejected> =>
  Effect.fail(new InstallerRejected({ reason }))

/**
 * The script as gent's installer, or why it is not one: `#!/bin/sh` first,
 * the marker line, and the closing `main "$@"` last.
 */
export const checkInstaller = (script: string): Effect.Effect<string, InstallerRejected> => {
  const lines = script.trimEnd().split("\n")
  if (lines[0] !== "#!/bin/sh") return reject("no #!/bin/sh first line")
  if (!lines.includes(INSTALLER_MARKER)) return reject("no installer marker line")
  if (lines.at(-1) !== INSTALLER_CALL) return reject(`no closing ${INSTALLER_CALL}`)
  return Effect.succeed(script)
}

/** True for an HTTPS URL on the default port of one of GitHub's release hosts. */
const onReleaseHost = (url: URL) =>
  url.protocol === "https:" && url.port === "" && RELEASE_HOSTS.has(url.hostname)

/** The next hop of a redirect, when it stays on HTTPS and on GitHub's release hosts. */
const redirectTarget = (
  location: Option.Option<string>,
  from: URL,
): Effect.Effect<URL, InstallerRejected> =>
  location.pipe(
    Option.flatMap((value) => Option.fromNullOr(URL.parse(value, from))),
    Option.match({
      onNone: () => reject("a redirect without a readable location"),
      onSome: (next) => {
        if (onReleaseHost(next)) return Effect.succeed(next)
        return reject(`a redirect off GitHub's release hosts: ${next.origin}`)
      },
    }),
  )

/**
 * The body of a 200, read up to `MAX_INSTALLER_BYTES`: the read stops as soon
 * as the body passes the bound, and a body shorter than its declared length
 * is incomplete.
 */
const boundedText = Effect.fn("Site.boundedText")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const declared = Option.fromUndefinedOr(response.headers["content-length"]).pipe(
    Option.map(Number),
  )
  if (Option.isSome(declared) && declared.value > MAX_INSTALLER_BYTES) {
    return yield* reject(`a body of ${declared.value} bytes`)
  }
  const chunks: Array<Uint8Array> = []
  let size = 0
  yield* Stream.runForEach(response.stream, (chunk) => {
    size += chunk.length
    if (size > MAX_INSTALLER_BYTES) return reject(`a body over ${MAX_INSTALLER_BYTES} bytes`)
    chunks.push(chunk)
    return Effect.void
  })
  if (Option.isSome(declared) && declared.value !== size) {
    return yield* reject(`${size} of ${declared.value} declared bytes`)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => new InstallerRejected({ reason: "a body that is not UTF-8" }),
  })
})

/**
 * The latest release's installer, fetched with the given client. The client
 * does not follow redirects itself (`fetch` with `redirect: "manual"`): each
 * hop is checked against the release hosts first. Only a complete 200 that
 * passes `checkInstaller` is the installer.
 */
const fetchReleaseInstaller = Effect.fn("Site.fetchReleaseInstaller")(function* (
  client: HttpClient.HttpClient,
) {
  let url = new URL(RELEASE_INSTALLER_URL)
  for (let hop = 0; ; hop++) {
    const response = yield* client
      .get(url)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
    if (response.status >= 300 && response.status < 400) {
      if (hop === MAX_REDIRECTS) return yield* reject(`more than ${MAX_REDIRECTS} redirects`)
      url = yield* redirectTarget(Option.fromUndefinedOr(response.headers["location"]), url)
      continue
    }
    if (response.status !== 200) return yield* reject(`status ${response.status}`)
    return yield* checkInstaller(yield* boundedText(response))
  }
})

const installResponse = (source: InstallSource, script: string) =>
  HttpServerResponse.text(script, {
    contentType: "text/plain; charset=utf-8",
    headers: {
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "x-gent-install-source": source,
    },
  })

// ── Landing page ─────────────────────────────────────────────────────────────

export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>gent</title>
<meta name="description" content="gent: a minimal, opinionated agent harness for the terminal, built on Effect.">
<style>
:root {
  --bg: #fbfaf7; --fg: #1c1b19; --muted: #6b675f; --line: #e3dfd6;
  --code-bg: #f1eee7; --accent: #2f5d50;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141412; --fg: #ebe8e1; --muted: #9b968c; --line: #2c2b28;
    --code-bg: #1e1d1a; --accent: #8cc4b0;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 17px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 40rem; margin: 0 auto; padding: 4rem 1rem 3rem; }
h1 { font: 600 2.5rem/1.1 ui-monospace, "SF Mono", Menlo, monospace; margin: 0 0 .5rem; letter-spacing: -.02em; }
.lede { font-size: 1.15rem; margin: 0 0 2.5rem; color: var(--muted); }
h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 2.5rem 0 .75rem; }
.install { display: flex; align-items: stretch; border: 1px solid var(--line); border-radius: 8px; background: var(--code-bg); overflow: hidden; }
.install code { flex: 1; min-width: 0; padding: .8rem 1rem; overflow-x: auto; white-space: nowrap; }
code { font: .9rem/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
button { font: inherit; font-size: .85rem; border: 0; border-left: 1px solid var(--line); background: transparent; color: var(--accent); padding: 0 1rem; cursor: pointer; }
button[hidden] { display: none; }
.note { font-size: .9rem; color: var(--muted); margin: .6rem 0 0; }
ul { padding-left: 1.2rem; margin: 0; }
li { margin: .4rem 0; }
a { color: var(--accent); text-underline-offset: .15em; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .9rem; color: var(--muted); display: flex; gap: 1.25rem; flex-wrap: wrap; }
</style>
</head>
<body>
<main>
<h1>gent</h1>
<p class="lede">A minimal, opinionated agent harness for the terminal, built on Effect.</p>

<h2>Install</h2>
<div class="install"><code id="line">${INSTALL_LINE}</code><button type="button" id="copy" hidden>Copy</button></div>
<p class="note">macOS and Linux. Two self-contained binaries, <code>gent</code> and its <code>gent-cell</code> worker: no Bun or Node needed to run them. <a href="/install.sh">Read the script</a> first if you like.</p>

<h2>What it is</h2>
<ul>
<li><strong>A lean core.</strong> Each session loop is one actor; every feature is an extension written in TypeScript against one public API.</li>
<li><strong>Cheap per task.</strong> The cached prompt prefix stays byte-stable and large output spills to storage, so each task sends the model only what it needs.</li>
<li><strong>One interaction model.</strong> The same key does the same thing on every screen of the TUI, and every state shows its way out.</li>
<li><strong>Effect-native.</strong> Services, layers, schemas and streams end to end.</li>
</ul>

<footer>
<a href="${REPO_URL}">GitHub</a>
<a href="${RELEASES_URL}">Releases</a>
<span>MIT</span>
</footer>
</main>
<script>
(() => {
  const button = document.getElementById("copy");
  const line = document.getElementById("line").textContent;
  if (!navigator.clipboard) return;
  button.hidden = false;
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(line).then(() => {
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1500);
    });
  });
})();
</script>
</body>
</html>
`

// ── Routes ───────────────────────────────────────────────────────────────────

/** The site's routes. The layer needs the HttpClient that reaches GitHub. */
export const layer = (options: SiteOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter
      const client = yield* HttpClient.HttpClient

      // One GitHub read serves every request for a few minutes; a miss is
      // kept for less time, so a new release shows up soon after it ships.
      // The cache runs the read in a fiber of its own, so a visitor who hangs
      // up mid-read does not leave an interruption for the next one.
      const releaseInstaller = yield* Cache.makeWith(
        (_: "latest") => fetchReleaseInstaller(client).pipe(Effect.timeout(FETCH_TIMEOUT)),
        {
          capacity: 1,
          timeToLive: Exit.match({ onSuccess: () => RELEASE_TTL, onFailure: () => MISS_TTL }),
        },
      )

      const install = Effect.gen(function* () {
        const release = yield* Effect.option(Cache.get(releaseInstaller, "latest"))
        if (Option.isSome(release)) return installResponse("release", release.value)
        if (Option.isSome(options.bundledInstaller)) {
          return installResponse("bundled", options.bundledInstaller.value)
        }
        return installResponse("none", NO_RELEASE_SCRIPT)
      })

      yield* router.add("GET", "/healthz", HttpServerResponse.text("ok"))
      yield* router.add("GET", "/install.sh", install)
      yield* router.add("GET", "/install", install)
      yield* router.add(
        "GET",
        "/",
        HttpServerResponse.html(LANDING_HTML).pipe(
          HttpServerResponse.setHeaders({
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
          }),
        ),
      )
    }),
  )
