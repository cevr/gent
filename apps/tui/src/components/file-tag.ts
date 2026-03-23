const fileTagGroups = [
  { tag: "[ts]", extensions: ["ts", "tsx"] },
  { tag: "[js]", extensions: ["js", "jsx"] },
  { tag: "[md]", extensions: ["md", "mdx"] },
  { tag: "[json]", extensions: ["json"] },
  { tag: "[css]", extensions: ["css", "scss", "less"] },
  { tag: "[html]", extensions: ["html"] },
  { tag: "[py]", extensions: ["py"] },
  { tag: "[rs]", extensions: ["rs"] },
  { tag: "[go]", extensions: ["go"] },
  { tag: "[yaml]", extensions: ["yaml", "yml"] },
  { tag: "[toml]", extensions: ["toml"] },
  { tag: "[sh]", extensions: ["sh", "bash", "zsh"] },
] as const

const fileTagByExtension = new Map<string, string>(
  fileTagGroups.flatMap(({ tag, extensions }) => extensions.map((ext) => [ext, tag] as const)),
)

export function getFileTag(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase()
  if (ext === undefined) return ""
  return fileTagByExtension.get(ext) ?? ""
}
