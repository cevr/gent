// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-dynamic-imports` fires for every dynamic loading shape:
//   - bare `import("...")`
//   - template-literal `import(`./${name}`)`
//   - conditional `require(...)` (still a require call regardless of guard)
//   - `module.require(...)`
//   - `createRequire(import.meta.url)("...")`

export const loadStaticPath = async () => {
  const mod = await import("./some-module.js")
  return mod
}

export const loadDynamicPath = async (name: string) => {
  const mod = await import(`./modules/${name}.js`)
  return mod
}

export const loadConditional = (cond: boolean) => {
  if (cond) {
    return require("node:fs")
  }
  return null
}

export const loadModuleRequire = () => {
  return module.require("node:os")
}

import { createRequire } from "node:module"
const req = createRequire(import.meta.url)
export const loadCreateRequire = () => {
  return req("node:path")
}

// Direct chained form: `createRequire(import.meta.url)("x")`
export const loadCreateRequireChained = () => {
  return createRequire(import.meta.url)("node:fs")
}
