import type { ThemeJson } from "./types"

import opencode from "./themes/opencode.json" with { type: "json" }
import catppuccin from "./themes/catppuccin.json" with { type: "json" }
import dracula from "./themes/dracula.json" with { type: "json" }
import nord from "./themes/nord.json" with { type: "json" }
import gruvbox from "./themes/gruvbox.json" with { type: "json" }
import tokyonight from "./themes/tokyonight.json" with { type: "json" }

export const DEFAULT_THEMES: Record<string, ThemeJson> = {
  opencode,
  catppuccin,
  dracula,
  nord,
  gruvbox,
  tokyonight,
}
