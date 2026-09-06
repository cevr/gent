import { Option } from "effect"

interface FileTagGroup {
  readonly tag: string
  readonly extensions: ReadonlyArray<string>
}

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
] satisfies ReadonlyArray<FileTagGroup>

const fileTagByExtension = new Map<string, string>(
  fileTagGroups.flatMap(({ tag, extensions }) =>
    extensions.map((ext): readonly [string, string] => [ext, tag]),
  ),
)

export function getFileTag(path: string): string {
  const extension = Option.fromNullishOr(path.split(".").pop()).pipe(
    Option.map((value) => value.toLowerCase()),
    Option.flatMap((value) => Option.fromNullishOr(fileTagByExtension.get(value))),
  )
  return Option.getOrElse(extension, () => "")
}
