// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-platform-module-export-alias` does NOT fire. A local
// alias and a layer read are upstream's to follow, a type import holds no
// layer, and other packages are no platform.
import { BunServices } from "@effect/platform-bun"
import type { BunPath } from "@effect/platform-bun"
import { layer as cryptoLayer } from "@effect/platform-bun/BunCrypto"
import { Layer } from "effect"

const Services = BunServices
export const socket = Services.makeNet
export const services = BunServices.layer
export const crypto = cryptoLayer
export const empty = Layer.empty
export type Paths = typeof BunPath
