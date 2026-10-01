// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-platform-module-export-alias` fires 8 times. Each
// export hands a platform binding to importers, where no rule follows it.
import { BunServices } from "@effect/platform-bun"
import * as PlatformBun from "@effect/platform-bun"
import * as BunPath from "@effect/platform-bun/BunPath"

const Local = BunServices
const Twice = Local
const { BunFileSystem: Files } = PlatformBun

export const Services = BunServices
export const FileSystem = PlatformBun.BunFileSystem
export const Paths = BunPath as typeof BunPath
export let platform = PlatformBun
export const LocalServices = Local
export const TwiceServices = Twice
export const LocalFiles = Files
export const socket = Local.makeNet
