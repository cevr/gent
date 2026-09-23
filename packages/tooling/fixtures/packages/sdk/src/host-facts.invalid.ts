// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` fires
// The SDK composes a server; its host facts come from GentPlatform.
declare const Bun: { spawn: (cmd: ReadonlyArray<string>) => unknown }
declare const process: { platform: string; pid: number }

export const platform = process.platform
export const pid = process.pid
export const proc = Bun.spawn(["echo", "hi"])
