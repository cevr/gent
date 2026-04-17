// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-dynamic-imports` fires for both dynamic import and require

export const loadDynamic = async () => {
  const mod = await import("./some-module.js")
  return mod
}

export const loadRequire = () => {
  const fs = require("node:fs")
  return fs
}
