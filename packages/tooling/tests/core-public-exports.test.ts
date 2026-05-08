import { describe, expect, test } from "bun:test"
import { findCorePublicExportFindings } from "../src/core-public-exports"

describe("core public export guard", () => {
  test("allows only extension api plus null internal export tombstones", () => {
    expect(
      findCorePublicExportFindings(
        {
          exports: {
            "./extensions/api": "./src/extensions/api.ts",
            "./extensions/api.js": "./src/extensions/api.ts",
            "./domain/*": null,
            "./runtime/*": null,
            "./test-utils": null,
            "./test-utils/*": null,
          },
        },
        {
          compilerOptions: {
            paths: {
              "@gent/core/extensions/api": ["./packages/core/src/extensions/api.ts"],
              "@gent/core/extensions/api.js": ["./packages/core/src/extensions/api.ts"],
              "@gent/core-internal/*.js": ["./packages/core/src/*.ts"],
              "@gent/core-internal/*": ["./packages/core/src/*"],
            },
          },
        },
        {
          private: true,
          exports: {
            "./*.js": "./src/*.ts",
            "./*": "./src/*.ts",
          },
        },
      ),
    ).toEqual([])
  })

  test("flags public internal package exports and tsconfig aliases", () => {
    expect(
      findCorePublicExportFindings(
        {
          exports: {
            "./extensions/api": "./src/extensions/api.ts",
            "./domain/ids": "./src/domain/ids.ts",
          },
        },
        {
          compilerOptions: {
            paths: {
              "@gent/core/domain/ids": ["./packages/core/src/domain/ids.ts"],
            },
          },
        },
      ),
    ).toEqual([
      {
        path: 'packages/core/package.json exports["./domain/ids"]',
        message:
          "Only @gent/core/extensions/api is public; workspace internals must use @gent/core-internal/*",
      },
      {
        path: 'tsconfig.json compilerOptions.paths["@gent/core/domain/ids"]',
        message: "Do not give TypeScript a public-looking @gent/core/* path for internal modules",
      },
    ])
  })

  test("keeps the workspace internal package private and narrow", () => {
    expect(
      findCorePublicExportFindings(
        {
          exports: {
            "./extensions/api": "./src/extensions/api.ts",
          },
        },
        { compilerOptions: { paths: {} } },
        {
          private: false,
          exports: {
            "./debug/*": "./src/debug/*.ts",
          },
        },
      ),
    ).toEqual([
      {
        path: "packages/core-internal/package.json private",
        message: "@gent/core-internal must stay private; it is not an extension author API",
      },
      {
        path: "packages/core-internal/package.json exports",
        message:
          "@gent/core-internal should only mirror core source through the private wildcard lane",
      },
    ])
  })
})
