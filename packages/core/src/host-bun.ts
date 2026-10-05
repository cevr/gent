/**
 * The Bun host: what a process on Bun adds to `host` to compose and run gent.
 * Its platform (`BunPlatformLive`: Bun's services, the fetch client,
 * `GentPlatform` and the provider lock file), its SQLite clients
 * (`BunSqlite`), its module binding (`bindBunModules`, `BunHostModules`).
 * Everything else a host composes is portable and lives in `host`, which a
 * Worker or a Durable Object root loads without Bun.
 */
export {
  bindBunModules,
  BunHostModules,
  BunPlatformLive,
  BunSqlite,
} from "./runtime/gent-platform-bun.js"
