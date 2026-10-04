// The site as a visitor and as `curl | sh` meet it: the routes the Railway
// service mounts, served over real HTTP on this machine, with GitHub replaced
// by a fake client that answers the release download the way `fetch` does.
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Ref,
  Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpRouter } from "effect/http"
import { ChildProcess } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import * as Site from "../src/site"

/** An installer the site accepts: the shebang, the marker, the closing call. */
const installer = (body: string) =>
  `#!/bin/sh\n${Site.INSTALLER_MARKER}\n\nmain() {\n  ${body}\n}\n\nmain "$@"\n`

const RELEASE_SCRIPT = installer("echo installing the release")
const BUNDLED_SCRIPT = installer("echo installing the bundled copy")

/** What the fake GitHub answers for each URL; any other URL is a 404. */
type Routes = Readonly<Record<string, () => Response>>

const redirect = (location: string) => () =>
  new Response("", { status: 302, headers: { location } })
const ok = (body: string) => () => new Response(body, { status: 200 })

const RELEASE_TAG_URL = "https://github.com/cevr/gent/releases/download/v0.1.0/install.sh"
const ASSET_URL =
  "https://release-assets.githubusercontent.com/github-production-release-asset/1/install.sh?sig=x"

/**
 * A GitHub that answers as `routes` say, counting requests. Like `fetch`, it
 * follows redirects itself unless the caller's `RequestInit` says "manual".
 */
const fakeGitHub = (routes: Routes) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const answer = (url: string) =>
      Option.fromUndefinedOr(routes[url]).pipe(
        Option.match({
          onNone: () => new Response("Not Found", { status: 404 }),
          onSome: (route) => route(),
        }),
      )
    const client = HttpClient.make((request, requestUrl, _signal, fiber) =>
      Effect.gen(function* () {
        yield* Ref.update(requests, (list) => [...list, requestUrl.href])
        const manual = Context.getOption(fiber.context, FetchHttpClient.RequestInit).pipe(
          Option.exists((init) => init.redirect === "manual"),
        )
        const follow = (url: string, hops: number): Response => {
          const response = answer(url)
          const location = Option.fromNullOr(response.headers.get("location"))
          const redirected = response.status >= 300 && response.status < 400
          if (manual || !redirected || Option.isNone(location) || hops === 20) return response
          return follow(new URL(location.value, url).href, hops + 1)
        }
        return HttpClientResponse.fromWeb(request, follow(requestUrl.href, 0))
      }),
    )
    return { layer: Layer.succeed(HttpClient.HttpClient, client), requests: Ref.get(requests) }
  })

const RELEASE = { [Site.RELEASE_INSTALLER_URL]: ok(RELEASE_SCRIPT) } satisfies Routes
const NO_RELEASE = {} satisfies Routes
const DOWN = {
  [Site.RELEASE_INSTALLER_URL]: () => new Response("unicorn", { status: 503 }),
} satisfies Routes

/** The site served on a test port, its GitHub reads going to `github`. */
const served = (github: Layer.Layer<HttpClient.HttpClient>, bundled: Option.Option<string>) =>
  HttpRouter.serve(Site.layer({ bundledInstaller: bundled }).pipe(Layer.provide(github))).pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
  )

const get = Effect.fn("test.get")(function* (path: string) {
  const response = yield* HttpClient.get(path)
  return { status: response.status, headers: response.headers, body: yield* response.text }
})

/** `/install.sh` as served when GitHub answers as `routes` say. */
const installFrom = (routes: Routes) =>
  Effect.gen(function* () {
    const github = yield* fakeGitHub(routes)
    return yield* get("/install.sh").pipe(
      Effect.provide(served(github.layer, Option.some(BUNDLED_SCRIPT))),
    )
  })

/** Run `script` the way `curl ... | sh` runs it: on the standard input of `sh`. */
const runSh = (script: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("sh", [], {
        stdin: Stream.make(new TextEncoder().encode(script)),
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "2 seconds",
      })
      const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
        Stream.decodeText(stream).pipe(Stream.mkString)
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [handle.exitCode, text(handle.stdout), text(handle.stderr)],
        { concurrency: "unbounded" },
      )
      return { exitCode: Number(exitCode), stdout, stderr }
    }),
  )

describe("install script", () => {
  it.live("serves the latest release's installer when one exists, and reads GitHub once", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub(RELEASE)
      yield* Effect.gen(function* () {
        for (const path of ["/install.sh", "/install", "/install.sh"]) {
          const response = yield* get(path)
          expect([path, response.status, response.body]).toEqual([path, 200, RELEASE_SCRIPT])
          expect(response.headers["x-gent-install-source"]).toBe("release")
          expect(response.headers["content-type"]).toContain("text/plain")
        }
      }).pipe(Effect.provide(served(github.layer, Option.some(BUNDLED_SCRIPT))))
      expect(yield* github.requests).toEqual([Site.RELEASE_INSTALLER_URL])
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("serves the bundled copy when GitHub has no release or fails", () =>
    Effect.gen(function* () {
      for (const [answer, routes] of [
        ["no-release", NO_RELEASE],
        ["down", DOWN],
      ] as const) {
        const response = yield* installFrom(routes)
        expect([answer, response.status, response.body]).toEqual([answer, 200, BUNDLED_SCRIPT])
        expect(response.headers["x-gent-install-source"]).toBe("bundled")
      }
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("with no release and no bundled copy, serves a script that says so and exits 1", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub(NO_RELEASE)
      const response = yield* get("/install.sh").pipe(
        Effect.provide(served(github.layer, Option.none())),
      )
      // 200, not 404: `curl -f` would print nothing and `sh` would exit 0.
      expect(response.status).toBe(200)
      expect(response.headers["x-gent-install-source"]).toBe("none")
      expect(response.body).toBe(Site.NO_RELEASE_SCRIPT)
      const run = yield* runSh(response.body)
      expect(run).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `gent: no release yet. Watch ${Site.RELEASES_URL}\n`,
      })
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

describe("release installer check", () => {
  it.live("serves the bundled copy when the release answer is not a complete installer", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, () => Response]> = [
        ["an HTML page", ok("<!doctype html><title>GitHub</title>")],
        // oxlint-disable-next-line effect/noNullish -- the Response constructor requires a null body for 204
        ["an empty 204", () => new Response(null, { status: 204 })],
        ["a partial 206", () => new Response(RELEASE_SCRIPT, { status: 206 })],
        ["a body over the size bound", ok(installer(`# ${"x".repeat(Site.MAX_INSTALLER_BYTES)}`))],
        ["a script without the marker", ok("#!/bin/sh\necho hello\n")],
        ["a script without the shebang", ok(RELEASE_SCRIPT.replace("#!/bin/sh\n", ""))],
        [
          "a script cut before its closing call",
          ok(RELEASE_SCRIPT.slice(0, -'main "$@"\n'.length)),
        ],
        [
          "a body shorter than its content-length",
          () =>
            new Response(RELEASE_SCRIPT, {
              status: 200,
              headers: { "content-length": String(RELEASE_SCRIPT.length + 10) },
            }),
        ],
      ]
      for (const [answer, response] of cases) {
        const served = yield* installFrom({ [Site.RELEASE_INSTALLER_URL]: response })
        expect([answer, served.status, served.headers["x-gent-install-source"]]).toEqual([
          answer,
          200,
          "bundled",
        ])
        expect(served.body).toBe(BUNDLED_SCRIPT)
      }
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("follows GitHub's redirects to its release asset host, one hop at a time", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub({
        [Site.RELEASE_INSTALLER_URL]: redirect(RELEASE_TAG_URL),
        [RELEASE_TAG_URL]: redirect(ASSET_URL),
        [ASSET_URL]: ok(RELEASE_SCRIPT),
      })
      const response = yield* get("/install.sh").pipe(
        Effect.provide(served(github.layer, Option.some(BUNDLED_SCRIPT))),
      )
      expect([response.headers["x-gent-install-source"], response.body]).toEqual([
        "release",
        RELEASE_SCRIPT,
      ])
      expect(yield* github.requests).toEqual([
        Site.RELEASE_INSTALLER_URL,
        RELEASE_TAG_URL,
        ASSET_URL,
      ])
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("refuses a redirect off https or off GitHub's release hosts", () =>
    Effect.gen(function* () {
      const targets = [
        "https://evil.example/install.sh",
        "https://release-assets.githubusercontent.com.evil.example/install.sh",
        "http://release-assets.githubusercontent.com/install.sh",
        "https://github.com:8443/cevr/gent/install.sh",
      ]
      for (const target of targets) {
        const response = yield* installFrom({
          [Site.RELEASE_INSTALLER_URL]: redirect(target),
          [target]: ok(RELEASE_SCRIPT),
        })
        expect([target, response.headers["x-gent-install-source"]]).toEqual([target, "bundled"])
      }
      const loop = yield* installFrom({
        [Site.RELEASE_INSTALLER_URL]: redirect(RELEASE_TAG_URL),
        [RELEASE_TAG_URL]: redirect(Site.RELEASE_INSTALLER_URL),
      })
      expect(loop.headers["x-gent-install-source"]).toBe("bundled")
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("the repo's install.sh, when the repo has one, passes the check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const script = path.join(
        yield* path.fromFileUrl(new URL("../../..", import.meta.url)),
        "install.sh",
      )
      if (!(yield* fs.exists(script))) return
      const checked = yield* Effect.exit(Site.checkInstaller(yield* fs.readFileString(script)))
      expect(checked._tag).toBe("Success")
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

describe("landing page", () => {
  it.live("says what gent is, gives the install line, and links GitHub and releases", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub(NO_RELEASE)
      const response = yield* get("/").pipe(Effect.provide(served(github.layer, Option.none())))
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("text/html")
      expect(response.body).toContain("agent harness")
      expect(response.body).toContain(Site.INSTALL_LINE)
      expect(response.body).toContain(`href="${Site.REPO_URL}"`)
      expect(response.body).toContain(`href="${Site.RELEASES_URL}"`)
      expect(response.body).toContain('name="viewport"')
      // The page loads nothing from anywhere else: no tracker, no font, no CDN.
      expect(response.body).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/)
      // Rendering the page asks GitHub nothing.
      expect(yield* github.requests).toEqual([])
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("answers the health check, and an unknown path is a 404", () =>
    Effect.gen(function* () {
      const github = yield* fakeGitHub(NO_RELEASE)
      yield* Effect.gen(function* () {
        const health = yield* get("/healthz")
        expect([health.status, health.body]).toEqual([200, "ok"])
        expect((yield* get("/nope")).status).toBe(404)
      }).pipe(Effect.provide(served(github.layer, Option.none())))
    }).pipe(Effect.timeout("8 seconds")),
  )
})
