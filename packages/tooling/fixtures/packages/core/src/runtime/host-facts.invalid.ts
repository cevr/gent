// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` fires
// Core source takes its working directory and host modules through services.
import { hostname } from "node:os"
import os from "os"
import { $ } from "bun"
import { createHash } from "crypto"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "url"
import "node:crypto"

export const cwd = process.cwd()
export const fallback = globalThis.process.cwd()
export const here = new URL(import.meta.url).pathname
export const lazyCrypto = import("node:crypto")
export const requiredUrl = require("node:url")
export const requiredBareUrl = require("url")
export const requiredCrypto = module.require("node:crypto")
export const digest = createHash("sha256")
export const bytes = randomBytes(32)
export const file = fileURLToPath(url)
export const used = [hostname, os, $, pathToFileURL]
