import figlet from "figlet"

const FONTS = ["Slant", "Calvin S", "ANSI Shadow", "Thin"] as const

export function getLogos(): string[] {
  return FONTS.map((font) => figlet.textSync("gent", { font }))
}
