// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` fires
// Core source takes its working directory and host modules through services.
import { hostname } from "node:os"
import { $ } from "bun"
import { createHash } from "crypto"
import { fileURLToPath } from "node:url"

export const cwd = process.cwd()
export const here = new URL(import.meta.url).pathname
export const used = [hostname, $, createHash, fileURLToPath]
