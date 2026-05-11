import { describe, expect, test } from "bun:test"
import {
  findCorePublicExportFindings,
  findExtensionsPublicExportFindings,
} from "../src/core-public-exports"

describe("core public export guard", () => {
  test("allows only extension api exports", () => {
    expect(
      findCorePublicExportFindings(
        {
          exports: {
            "./extensions/api": "./src/extensions/api.ts",
            "./extensions/api.js": "./src/extensions/api.ts",
            "./extensions/api/bun": "./src/extensions/api-bun.ts",
            "./extensions/api/bun.js": "./src/extensions/api-bun.ts",
          },
        },
        {
          compilerOptions: {
            paths: {
              "@gent/core/extensions/api": ["./packages/core/src/extensions/api.ts"],
              "@gent/core/extensions/api.js": ["./packages/core/src/extensions/api.ts"],
              "@gent/core/extensions/api/bun": ["./packages/core/src/extensions/api-bun.ts"],
              "@gent/core/extensions/api/bun.js": ["./packages/core/src/extensions/api-bun.ts"],
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

  test("flags null tombstones as extra public export surface", () => {
    expect(
      findCorePublicExportFindings(
        {
          exports: {
            "./extensions/api": "./src/extensions/api.ts",
            "./runtime/*": null,
          },
        },
        { compilerOptions: { paths: {} } },
      ),
    ).toEqual([
      {
        path: 'packages/core/package.json exports["./runtime/*"]',
        message:
          "Only @gent/core/extensions/api is public; workspace internals must use @gent/core-internal/*",
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

describe("extensions public export guard", () => {
  test("allows only root composition and client contracts", () => {
    expect(
      findExtensionsPublicExportFindings(
        {
          private: true,
          exports: {
            ".": "./src/index.ts",
            "./index.js": "./src/index.ts",
            "./client": "./src/client.ts",
            "./client.js": "./src/client.ts",
          },
        },
        {
          compilerOptions: {
            paths: {
              "@gent/extensions": ["./packages/extensions/src/index.ts"],
              "@gent/extensions/index.js": ["./packages/extensions/src/index.ts"],
              "@gent/extensions/client": ["./packages/extensions/src/client.ts"],
              "@gent/extensions/client.js": ["./packages/extensions/src/client.ts"],
            },
          },
        },
      ),
    ).toEqual([])
  })

  test("flags extension implementation subpaths", () => {
    expect(
      findExtensionsPublicExportFindings(
        {
          private: false,
          exports: {
            ".": "./src/index.ts",
            "./todo-storage": "./src/todo-storage.ts",
          },
        },
        {
          compilerOptions: {
            paths: {
              "@gent/extensions/todo-storage": ["./packages/extensions/src/todo-storage.ts"],
            },
          },
        },
      ),
    ).toEqual([
      {
        path: "packages/extensions/package.json private",
        message:
          "@gent/extensions is the builtin composition package; publish only root/client contracts",
      },
      {
        path: 'packages/extensions/package.json exports["./todo-storage"]',
        message:
          "@gent/extensions may only expose root composition and ./client; use relative source imports for internal extension tests",
      },
      {
        path: 'tsconfig.json compilerOptions.paths["@gent/extensions/todo-storage"]',
        message:
          "Do not create public-looking @gent/extensions/* aliases for extension implementation internals",
      },
    ])
  })
})
