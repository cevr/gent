// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-platform-module-export-alias` does NOT fire. A layer
// read, through an alias too, is upstream's to report, a local alias that is
// never exported hands nothing on, a type import holds no layer, and other
// packages are no platform.
import { BunServices } from "@effect/platform-bun"
import type { BunPath } from "@effect/platform-bun"
import * as PlatformBun from "@effect/platform-bun"
import { layer as cryptoLayer } from "@effect/platform-bun/BunCrypto"
import { Layer } from "effect"

const Local = BunServices
const { layer: pathLayer } = PlatformBun.BunPath
const unexported = Local
export const services = BunServices.layer
export const localLayer = Local.layer
export const path = pathLayer
export const crypto = cryptoLayer
export const empty = Layer.empty
export const used = [unexported]
export type Paths = typeof BunPath
