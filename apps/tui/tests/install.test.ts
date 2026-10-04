import { describe, expect, it } from "effect-bun-test"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { ConfigProvider, Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { runProcess } from "@gent/core/extensions/api"
import { GentPlatform } from "@gent/core/host"
import { BunGentPlatformLive, makeTempDirectoryScoped } from "@gent/core/test-utils"
import { formatUpgradeOutcome, upgradeInstall } from "../src/ops"

// ── a release host on loopback ──────────────────────────────────────────────

/** install.sh and `gent upgrade` read this variable; the tests point it at the fixture host. */
const RELEASES_URL = "GENT_RELEASES_URL"

/** Every platform name the release holds: the fixture serves one pair for each. */
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const

interface FixtureRelease {
  readonly archive: Uint8Array
  readonly sums: string
}

/**
 * A release of `version`: an archive whose `gent` prints `gent v<version>`,
 * and the SHA256SUMS that names it for each platform. `tampered` gives sums
 * that match no archive.
 */
const makeRelease = (version: string, options: { readonly tampered?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* GentPlatform
    const dir = yield* makeTempDirectoryScoped("gent-release-fixture-")
    const pair = path.join(dir, "pair")
    yield* fs.makeDirectory(pair)
    yield* fs.writeFileString(path.join(pair, "gent"), `#!/bin/sh\necho "gent v${version}"\n`)
    yield* fs.writeFileString(path.join(pair, "gent-cell"), "#!/bin/sh\n")
    yield* fs.chmod(path.join(pair, "gent"), 0o755)
    yield* fs.chmod(path.join(pair, "gent-cell"), 0o755)
    const archivePath = path.join(dir, "pair.tar.gz")
    const packed = yield* runProcess("tar", ["-czf", archivePath, "-C", pair, "gent", "gent-cell"])
    expect(packed.exitCode).toBe(0)
    const archive = yield* fs.readFile(archivePath)
    let digest = platform.hash("sha256", archive)
    if (options.tampered === true) digest = "0".repeat(64)
    const sums = PLATFORMS.map((name) => `${digest}  gent-${name}.tar.gz\n`).join("")
    return { archive, sums } satisfies FixtureRelease
  })

/**
 * Serve `releases` the way GitHub serves a releases page: `/latest`
 * redirects to the latest tag's page, and `/download/v<version>/<asset>`
 * holds the assets. Returns the releases URL; the listener closes with the
 * scope.
 */
const serveReleases = (releases: ReadonlyMap<string, FixtureRelease>, latest: string) =>
  Effect.gen(function* () {
    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://127.0.0.1")
      if (url.pathname === "/releases/latest") {
        return HttpServerResponse.redirect(`/releases/tag/v${latest}`, { status: 302 })
      }
      if (url.pathname.startsWith("/releases/tag/")) return HttpServerResponse.text("release")
      const asset = Option.fromNullishOr(
        /^\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(url.pathname),
      ).pipe(Option.map((match) => ({ version: match[1] ?? "", name: match[2] ?? "" })))
      const release = asset.pipe(
        Option.flatMap(({ version }) => Option.fromNullishOr(releases.get(version))),
      )
      if (Option.isNone(asset) || Option.isNone(release)) {
        return HttpServerResponse.text("not found", { status: 404 })
      }
      if (asset.value.name === "SHA256SUMS") return HttpServerResponse.text(release.value.sums)
      if (/^gent-[a-z0-9-]+\.tar\.gz$/.test(asset.value.name)) {
        return HttpServerResponse.uint8Array(release.value.archive)
      }
      return HttpServerResponse.text("not found", { status: 404 })
    })
    const context = yield* Layer.build(
      HttpServer.serve(app).pipe(
        Layer.provideMerge(BunHttpServer.layerServer({ port: 0, hostname: "127.0.0.1" })),
      ),
    )
    const address = Context.get(context, HttpServer.HttpServer).address
    if (address._tag === "UnixPathAddress") return yield* Effect.die("a TCP listener has no path")
    return `http://127.0.0.1:${address.port}/releases`
  })

// ── install.sh ──────────────────────────────────────────────────────────────

const installScript = Effect.gen(function* () {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("../../../install.sh", import.meta.url))
})

/**
 * Run install.sh as `curl ... | sh` runs it, in a scratch home with a
 * minimal PATH and zsh as the login shell.
 */
const install = (
  home: string,
  releases: string,
  args: ReadonlyArray<string> = [],
  env: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const script = yield* installScript
    return yield* runProcess("sh", [script, ...args], {
      cwd: home,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        SHELL: "/bin/zsh",
        [RELEASES_URL]: releases,
        ...env,
      },
      extendEnv: false,
    }).pipe(Effect.timeout("30 seconds"))
  })

/** The installed layout under `home`: versions, the current link, the bin link. */
const layout = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.join(home, ".local", "share", "gent")
    const versionsDir = path.join(root, "versions")
    let versions: ReadonlyArray<string> = []
    if (yield* fs.exists(versionsDir)) versions = [...(yield* fs.readDirectory(versionsDir))].sort()
    const link = (file: string) => fs.readLink(file).pipe(Effect.option)
    return {
      root,
      versions,
      current: yield* link(path.join(root, "gent")),
      bin: yield* link(path.join(home, ".local", "bin", "gent")),
    }
  })

const services = Layer.merge(BunServices.layer, BunGentPlatformLive)

describe("install.sh", () => {
  it.scopedLive("installs the latest release behind one current link and a bin link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* makeTempDirectoryScoped("gent-install-home-")
      const releases = yield* serveReleases(
        new Map([
          ["1.1.0", yield* makeRelease("1.1.0")],
          ["1.2.0", yield* makeRelease("1.2.0")],
        ]),
        "1.2.0",
      )

      const first = yield* install(home, releases)
      expect(first.exitCode).toBe(0)
      const installed = yield* layout(home)
      expect(installed).toEqual({
        root: installed.root,
        versions: ["1.2.0"],
        current: Option.some("versions/1.2.0/gent"),
        bin: Option.some(path.join(installed.root, "gent")),
      })
      const pair = [...(yield* fs.readDirectory(path.join(installed.root, "versions", "1.2.0")))]
      expect(pair.sort()).toEqual(["gent", "gent-cell"])
      const ran = yield* runProcess(path.join(home, ".local", "bin", "gent"), ["--version"])
      expect(ran.stdout.trim()).toBe("gent v1.2.0")

      // The bin directory is not on PATH: zsh's startup file gains it, once.
      const rc = path.join(home, ".zshrc")
      const pathLine = `export PATH="${path.join(home, ".local", "bin")}:$PATH"`
      expect(first.stderr).toContain(`added ${path.join(home, ".local", "bin")} to PATH in ${rc}`)
      const again = yield* install(home, releases)
      expect(again.exitCode).toBe(0)
      expect((yield* fs.readFileString(rc)).split(pathLine).length - 1).toBe(1)
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive(
    "a pinned version installs, and each install keeps only the version it replaces",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("gent-install-home-")
        const releases = yield* serveReleases(
          new Map([
            ["1.1.0", yield* makeRelease("1.1.0")],
            ["1.2.0", yield* makeRelease("1.2.0")],
            ["1.3.0", yield* makeRelease("1.3.0")],
          ]),
          "1.3.0",
        )
        for (const version of ["1.1.0", "v1.2.0"]) {
          expect((yield* install(home, releases, ["--version", version])).exitCode).toBe(0)
        }
        expect((yield* layout(home)).versions).toEqual(["1.1.0", "1.2.0"])
        expect((yield* layout(home)).current).toEqual(Option.some("versions/1.2.0/gent"))

        const latest = yield* install(home, releases)
        expect(latest.exitCode).toBe(0)
        expect(latest.stderr).toContain("the previous version, 1.2.0, stays beside it")
        const after = yield* layout(home)
        expect({ versions: after.versions, current: after.current }).toEqual({
          versions: ["1.2.0", "1.3.0"],
          current: Option.some("versions/1.3.0/gent"),
        })
      }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive("an archive that does not match SHA256SUMS installs nothing", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("gent-install-home-")
      const releases = yield* serveReleases(
        new Map([["1.2.0", yield* makeRelease("1.2.0", { tampered: true })]]),
        "1.2.0",
      )
      const result = yield* install(home, releases)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("does not match the SHA256SUMS of v1.2.0")
      const after = yield* layout(home)
      expect({ versions: after.versions, current: after.current, bin: after.bin }).toEqual({
        versions: [],
        current: Option.none(),
        bin: Option.none(),
      })
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive("a version that has no release installs nothing", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("gent-install-home-")
      const releases = yield* serveReleases(
        new Map([["1.2.0", yield* makeRelease("1.2.0")]]),
        "1.2.0",
      )
      const result = yield* install(home, releases, ["--version", "9.9.9"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("could not download")
      expect((yield* layout(home)).versions).toEqual([])
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive(
    "--from installs a local pair as dev-<digest of its gent>, and the PATH stays as it is",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const home = yield* makeTempDirectoryScoped("gent-install-home-")
        const build = path.join(home, "build")
        yield* fs.makeDirectory(build)
        yield* fs.writeFileString(path.join(build, "gent"), '#!/bin/sh\necho "gent v0.0.0"\n')
        yield* fs.writeFileString(path.join(build, "gent-cell"), "#!/bin/sh\n")
        const digest = platform.hash("sha256", yield* fs.readFile(path.join(build, "gent")))

        // No release host: a local install reads none.
        const result = yield* install(home, "http://127.0.0.1:9/releases", [
          "--from",
          build,
          "--no-modify-path",
        ])
        expect(result.exitCode).toBe(0)
        const version = `dev-${digest.slice(0, 12)}`
        expect(yield* layout(home)).toMatchObject({
          versions: [version],
          current: Option.some(`versions/${version}/gent`),
        })
        expect(yield* fs.exists(path.join(home, ".zshrc"))).toBe(false)
        expect(result.stderr).toContain(`add ${path.join(home, ".local", "bin")} to PATH`)
      }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive("another gent earlier on PATH is reported", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* makeTempDirectoryScoped("gent-install-home-")
      const releases = yield* serveReleases(
        new Map([["1.2.0", yield* makeRelease("1.2.0")]]),
        "1.2.0",
      )
      const bunBin = path.join(home, ".bun", "bin")
      yield* fs.makeDirectory(bunBin, { recursive: true })
      yield* fs.writeFileString(path.join(bunBin, "gent"), "#!/bin/sh\n")
      yield* fs.chmod(path.join(bunBin, "gent"), 0o755)
      const result = yield* install(home, releases, [], {
        PATH: `${bunBin}:${path.join(home, ".local", "bin")}:/usr/bin:/bin`,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain(
        `${bunBin}/gent comes before ${path.join(home, ".local", "bin")} on PATH`,
      )
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )
})

// ── gent upgrade ────────────────────────────────────────────────────────────

/**
 * Run `gent upgrade` as the gent at `executable` (a real path) of build
 * `build`, against the release host at `releases`.
 */
const upgradeAs = (
  executable: string,
  build: GentBuild,
  releases: string,
  requested: Option.Option<string> = Option.none(),
) =>
  Effect.scoped(upgradeInstall(requested)).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ [RELEASES_URL]: releases }),
    ),
    Effect.provide(
      Layer.merge(
        Layer.effect(
          GentPlatform,
          Effect.gen(function* () {
            const platform = yield* GentPlatform
            return GentPlatform.of({
              ...platform,
              execPath: Effect.succeed(executable),
              build: Effect.succeed(build),
            })
          }),
        ).pipe(Layer.provide(BunGentPlatformLive)),
        FetchHttpClient.layer,
      ),
    ),
  )

type GentBuild = Effect.Success<GentPlatform["Service"]["build"]>

const compiled = (version: string): GentBuild => ({ _tag: "Compiled", id: "4f9c2e1a", version })

/** A scratch home where install.sh installed each of `versions`, in order. */
const installedHome = (releases: string, versions: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const home = yield* makeTempDirectoryScoped("gent-upgrade-home-")
    for (const version of versions) {
      const installed = yield* install(home, releases, ["--version", version, "--no-modify-path"])
      expect(installed.exitCode).toBe(0)
    }
    return home
  })

/** The real path of the gent of `version` in the install under `home`. */
const installedGent = (home: string, version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* fs.realPath(path.join((yield* layout(home)).root, "versions", version, "gent"))
  })

const threeReleases = Effect.gen(function* () {
  return yield* serveReleases(
    new Map([
      ["1.1.0", yield* makeRelease("1.1.0")],
      ["1.2.0", yield* makeRelease("1.2.0")],
      ["1.3.0", yield* makeRelease("1.3.0")],
    ]),
    "1.3.0",
  )
})

describe("gent upgrade", () => {
  it.scopedLive("moves an install to the latest release and keeps the version it replaces", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const releases = yield* threeReleases
      const home = yield* installedHome(releases, ["1.1.0", "1.2.0"])
      const before = yield* layout(home)

      const outcome = yield* upgradeAs(
        yield* installedGent(home, "1.2.0"),
        compiled("1.2.0"),
        releases,
      )
      expect(outcome).toEqual({
        _tag: "Upgraded",
        from: "1.2.0",
        to: "1.3.0",
        directory: path.join(before.root, "versions", "1.3.0"),
      })
      const after = yield* layout(home)
      expect(after).toEqual({
        root: before.root,
        versions: ["1.2.0", "1.3.0"],
        current: Option.some("versions/1.3.0/gent"),
        bin: before.bin,
      })
      const ran = yield* runProcess(path.join(home, ".local", "bin", "gent"), ["--version"])
      expect(ran.stdout.trim()).toBe("gent v1.3.0")
      expect(formatUpgradeOutcome(outcome).split("\n").at(-1)).toBe(
        "A gent of v1.2.0 that still runs keeps its server: close it, or run `gent server stop`, before you start v1.3.0.",
      )
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive("installs a pinned version, and the latest when it runs says so", () =>
    Effect.gen(function* () {
      const releases = yield* threeReleases
      const home = yield* installedHome(releases, ["1.3.0"])
      const pinned = yield* upgradeAs(
        yield* installedGent(home, "1.3.0"),
        compiled("1.3.0"),
        releases,
        Option.some("v1.1.0"),
      )
      expect(pinned._tag).toBe("Upgraded")
      expect((yield* layout(home)).versions).toEqual(["1.1.0", "1.3.0"])

      const latest = yield* upgradeAs(
        yield* installedGent(home, "1.3.0"),
        compiled("1.3.0"),
        releases,
      )
      expect(latest).toEqual({ _tag: "Current", version: "1.3.0" })
      expect(formatUpgradeOutcome(latest)).toBe("Already at gent v1.3.0.")
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive("an archive that does not match SHA256SUMS changes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const good = yield* serveReleases(new Map([["1.2.0", yield* makeRelease("1.2.0")]]), "1.2.0")
      const home = yield* installedHome(good, ["1.2.0"])
      const tampered = yield* serveReleases(
        new Map([["1.3.0", yield* makeRelease("1.3.0", { tampered: true })]]),
        "1.3.0",
      )
      const before = yield* layout(home)
      const error = yield* upgradeAs(
        yield* installedGent(home, "1.2.0"),
        compiled("1.2.0"),
        tampered,
      ).pipe(Effect.flip)
      expect(error.message).toContain("does not match the SHA256SUMS of v1.3.0")
      expect(yield* layout(home)).toEqual(before)
      // The work directory went with the scope.
      expect([...(yield* fs.readDirectory(path.join(before.root, "versions")))]).toEqual(["1.2.0"])
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(services)),
  )

  it.scopedLive("a gent inside node_modules is left to its package manager", () =>
    Effect.gen(function* () {
      const executable = "/nonexistent/loop-probe-x/node_modules/@gent/linux-x64/bin/gent"
      const outcome = yield* upgradeAs(executable, compiled("1.2.0"), "http://127.0.0.1:9/releases")
      expect(outcome).toEqual({ _tag: "PackageManager", executable })
      expect(formatUpgradeOutcome(outcome)).toContain("upgrade it with that package manager")
    }).pipe(Effect.timeout("30 seconds"), Effect.provide(services)),
  )

  it.scopedLive("a source run and a gent outside an install are refused", () =>
    Effect.gen(function* () {
      const nowhere = "http://127.0.0.1:9/releases"
      const source = yield* upgradeAs(
        "/nonexistent/loop-probe-x/bun",
        { _tag: "Source" },
        nowhere,
      ).pipe(Effect.flip)
      expect(source.message).toContain("this gent runs from a source checkout")
      const elsewhere = yield* upgradeAs(
        "/nonexistent/loop-probe-x/bin/gent",
        compiled("1.2.0"),
        nowhere,
      ).pipe(Effect.flip)
      expect(elsewhere.message).toContain(
        "this one runs from /nonexistent/loop-probe-x/bin/gent. Install a release with: curl -fsSL https://gent.cvr.im/install.sh | sh",
      )
    }).pipe(Effect.timeout("30 seconds"), Effect.provide(services)),
  )
})
