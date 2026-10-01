// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-platform-module-export-alias` fires 4 times. Each
// export hands a platform binding to importers, where no rule follows it.
import { BunServices } from "@effect/platform-bun"
import * as PlatformBun from "@effect/platform-bun"
import * as BunPath from "@effect/platform-bun/BunPath"

export const Services = BunServices
export const FileSystem = PlatformBun.BunFileSystem
export const Paths = BunPath as typeof BunPath
export let platform = PlatformBun
