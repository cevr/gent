#!/bin/sh
# Install gent, the minimal agent harness: https://github.com/cevr/gent
#
#   curl -fsSL https://gent.cvr.im/install.sh | sh
#   curl -fsSL https://gent.cvr.im/install.sh | sh -s -- --version 0.2.0
#
# Options:
#   --version <v>      install release v<v>; without it, the latest release
#   --from <dir>       install the gent and gent-cell pair a local build left in
#                      <dir>, as version dev-<digest of its gent>
#   --no-modify-path   do not add the bin directory to a shell startup file
#
# It installs one release for this machine (macOS or glibc Linux, x64 or
# arm64) from https://github.com/cevr/gent/releases, checks the archive against
# the release's SHA256SUMS, and lays it out as:
#
#   ${XDG_DATA_HOME:-~/.local/share}/gent/versions/<v>/gent, gent-cell
#   ${XDG_DATA_HOME:-~/.local/share}/gent/gent -> versions/<v>/gent  (current)
#   ~/.local/bin/gent -> ${XDG_DATA_HOME:-~/.local/share}/gent/gent
#
# The current link changes in one rename, and a version directory never
# changes once it is in place, so a gent that runs keeps its own pair. One
# install at a time holds <root>/.lock while it switches and prunes. The
# current and the previous version stay, and so does every version a running
# gent marks in <version>/.in-use/<pid>. `gent upgrade` runs the release's own
# install.sh. GENT_RELEASES_URL names another release host, such as a mirror,
# with the same paths as the GitHub releases page.
#
# Everything is inside main, so a download cut short runs nothing.

set -eu

main() {
  releases="${GENT_RELEASES_URL:-https://github.com/cevr/gent/releases}"
  root="${XDG_DATA_HOME:-$HOME/.local/share}/gent"
  bin="$HOME/.local/bin"
  version=""
  from=""
  modify_path=1

  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || fail "--version needs a version, such as --version 0.2.0"
        version="${2#v}"
        shift 2
        ;;
      --version=*)
        version="${1#--version=}"
        version="${version#v}"
        shift
        ;;
      --from)
        [ $# -ge 2 ] || fail "--from needs the directory that holds gent and gent-cell"
        from="$2"
        shift 2
        ;;
      --from=*)
        from="${1#--from=}"
        shift
        ;;
      --no-modify-path)
        modify_path=0
        shift
        ;;
      -h | --help)
        sed -n '2,29p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
        return 0
        ;;
      *)
        fail "unknown option $1 (options: --version <v>, --from <dir>, --no-modify-path)"
        ;;
    esac
  done
  [ -z "$version" ] || [ -z "$from" ] || fail "choose --version or --from, not both"
  [ -z "$version" ] || check_version "$version"

  for tool in tar mkdir ln mv cmp; do need "$tool"; done
  mkdir -p "$root/versions"
  lock="$root/.lock"
  locked=0
  work="$(mktemp -d "$root/versions/.tmp-XXXXXX")"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -n "$from" ]; then
    stage_local "$from"
  else
    stage_release
  fi

  # One updater at a time reads the current version, places the new one,
  # switches and prunes: another updater's switch never lands between them.
  take_lock
  previous="$(current_version)"
  place_version
  switch_current
  link_bin
  prune
  release_lock
  say "installed gent $version into $root/versions/$placed"
  [ -z "$previous" ] || [ "$previous" = "$placed" ] || say "the previous version, $previous, stays beside it"
  edit_path
  report_shadow
  [ -z "$previous" ] || [ "$previous" = "$placed" ] ||
    say "a gent of $previous that still runs keeps its server: close it, or run \`gent server stop\`, before you start this one"
}

# ── the platform ────────────────────────────────────────────────────────────

platform() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN* | Windows*) fail "gent runs on macOS and Linux; on Windows, run this inside WSL" ;;
    *) fail "gent runs on macOS and Linux, not on $os" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "gent runs on x64 and arm64, not on $arch" ;;
  esac
  # A shell under Rosetta reports x64 on an arm64 Mac: install the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ] && is_musl; then
    fail "gent's Linux builds need glibc; this system uses musl (Alpine and similar)"
  fi
  echo "$os-$arch"
}

is_musl() {
  for loader in /lib/ld-musl-*; do
    [ -e "$loader" ] && return 0
  done
  ldd --version 2>&1 | grep -qi musl
}

# ── staging: the pair lands in $work, $version names it ─────────────────────

stage_release() {
  need curl
  target="$(platform)"
  if [ -z "$version" ]; then
    # The latest release's page redirects to its tag: .../releases/tag/v<version>.
    latest="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$releases/latest")" ||
      fail "could not reach $releases/latest"
    tag="${latest##*/}"
    case "$tag" in
      v[0-9]*) version="${tag#v}" ;;
      *) fail "$releases has no published release" ;;
    esac
    check_version "$version"
  fi
  archive="gent-$target.tar.gz"
  say "downloading gent $version for $target"
  download "$releases/download/v$version/$archive" "$work/$archive"
  download "$releases/download/v$version/SHA256SUMS" "$work/SHA256SUMS"
  expected="$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")"
  [ -n "$expected" ] || fail "the SHA256SUMS of v$version names no $archive"
  actual="$(sha256 "$work/$archive")"
  [ "$actual" = "$expected" ] || fail "$archive does not match the SHA256SUMS of v$version (expected $expected, got $actual)"
  mkdir "$work/pair"
  tar -xzf "$work/$archive" -C "$work/pair"
  check_pair "$work/pair"
}

stage_local() {
  [ -f "$1/gent" ] && [ -f "$1/gent-cell" ] || fail "$1 does not hold a gent and gent-cell pair; build first (bun run build)"
  digest="$(sha256 "$1/gent")"
  version="dev-$(printf '%s' "$digest" | cut -c1-12)"
  mkdir "$work/pair"
  cp "$1/gent" "$1/gent-cell" "$work/pair/"
  check_pair "$work/pair"
}

# The pair runs here before anything points at it.
check_pair() {
  [ -f "$1/gent" ] && [ -f "$1/gent-cell" ] || fail "the archive does not hold gent and gent-cell"
  chmod 755 "$1/gent" "$1/gent-cell"
  printed="$("$1/gent" --version 2>&1)" || fail "the new gent does not start: $printed"
  case "$version" in
    dev-*) ;;
    *) [ "$printed" = "gent v$version" ] || fail "the archive of v$version holds a gent that prints \"$printed\"" ;;
  esac
}

# ── the layout ──────────────────────────────────────────────────────────────

# The lock is a directory: mkdir makes it or fails, in one step, on every
# system. It holds the owner's PID. A lock whose owner is gone is moved aside
# (one rename, so one waiter wins it) and removed.
take_lock() {
  waited=0
  unnamed=0
  while :; do
    if mkdir "$lock" 2>/dev/null; then
      echo "$$" >"$lock/pid"
      locked=1
      return 0
    fi
    owner="$(cat "$lock/pid" 2>/dev/null || true)"
    stale=0
    if [ -n "$owner" ]; then
      unnamed=0
      kill -0 "$owner" 2>/dev/null || stale=1
    else
      # A new lock names its owner at once; one that stays unnamed lost its owner.
      unnamed=$((unnamed + 1))
      [ "$unnamed" -lt 5 ] || stale=1
    fi
    if [ "$stale" = 1 ]; then
      if mv "$lock" "$root/.lock-stale-$$" 2>/dev/null; then
        taken="$(cat "$root/.lock-stale-$$/pid" 2>/dev/null || true)"
        if [ "$taken" = "$owner" ]; then
          rm -rf "$root/.lock-stale-$$"
        elif [ ! -e "$lock" ]; then
          # Another waiter took the stale lock first: give its lock back.
          mv "$root/.lock-stale-$$" "$lock" 2>/dev/null || true
        fi
      fi
      continue
    fi
    if [ "$waited" = 0 ]; then
      say "waiting for another install (PID ${owner:-starting}) to finish"
      waited=1
    fi
    sleep 1
  done
}

release_lock() {
  [ "$locked" = 1 ] || return 0
  locked=0
  [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$$" ] && rm -rf "$lock"
  return 0
}

cleanup() {
  release_lock
  remove_tree "$work"
}

# The version directory the current link names, or nothing.
current_version() {
  [ -L "$root/gent" ] || return 0
  target="$(readlink "$root/gent")"
  case "$target" in
    versions/*/gent) target="${target#versions/}" && echo "${target%/gent}" ;;
  esac
}

# An installed version directory never changes, so a gent that runs from it
# keeps its pair. A directory whose pair matches the new one is reused; any
# other pair goes in under a fresh name, `<version>_<suffix>`. $placed names
# the directory the current link will name.
place_version() {
  placed="$version"
  if [ -e "$root/versions/$placed" ]; then
    if same_pair "$work/pair" "$root/versions/$placed"; then
      return 0
    fi
    placed="${version}_${work##*/.tmp-}"
  fi
  mv "$work/pair" "$root/versions/$placed"
}

same_pair() {
  cmp -s "$1/gent" "$2/gent" && cmp -s "$1/gent-cell" "$2/gent-cell"
}

# One rename switches the current version: a link made under a temporary name
# replaces the old link, so no moment holds no current version.
switch_current() {
  ln -s "versions/$placed/gent" "$root/.gent-link-$$"
  mv -f "$root/.gent-link-$$" "$root/gent"
}

link_bin() {
  mkdir -p "$bin"
  if [ -L "$bin/gent" ] && [ "$(readlink "$bin/gent")" = "$root/gent" ]; then
    return 0
  fi
  [ ! -e "$bin/gent" ] || [ -L "$bin/gent" ] || say "replacing the file $bin/gent with a link to the installed version"
  ln -s "$root/gent" "$bin/.gent-link-$$"
  mv -f "$bin/.gent-link-$$" "$bin/gent"
}

# Keep the new version, the one it replaces, and every version a gent that
# runs still uses; remove the rest.
prune() {
  for dir in "$root"/versions/*; do
    [ -d "$dir" ] || continue
    name="${dir##*/}"
    [ "$name" = "$placed" ] && continue
    [ -n "$previous" ] && [ "$name" = "$previous" ] && continue
    in_use "$dir" && continue
    remove_tree "$dir"
  done
}

# A gent writes `<version dir>/.in-use/<pid>` at start and removes it at exit.
# A marker whose process is gone (a crash, a kill -9) is removed here.
in_use() {
  [ -d "$1/.in-use" ] || return 1
  live=1
  for marker in "$1/.in-use"/*; do
    [ -e "$marker" ] || continue
    pid="${marker##*/}"
    case "$pid" in
      "" | *[!0-9]*) ;;
      *) if kill -0 "$pid" 2>/dev/null; then live=0 && continue; fi ;;
    esac
    rm -f "$marker"
  done
  return "$live"
}

# ── PATH ────────────────────────────────────────────────────────────────────

edit_path() {
  case ":$PATH:" in
    *":$bin:"*) return 0 ;;
  esac
  if [ "$modify_path" = 0 ]; then
    say "add $bin to PATH to run gent"
    return 0
  fi
  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh)
      rc="${ZDOTDIR:-$HOME}/.zshrc"
      line="export PATH=\"$bin:\$PATH\""
      ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$bin:\$PATH\""
      ;;
    fish)
      rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      line="fish_add_path \"$bin\""
      ;;
    *)
      rc="$HOME/.profile"
      line="export PATH=\"$bin:\$PATH\""
      ;;
  esac
  if [ -f "$rc" ] && grep -qF "$line" "$rc"; then
    say "$rc already adds $bin to PATH; open a new shell to run gent"
    return 0
  fi
  mkdir -p "$(dirname "$rc")"
  printf '\n# gent\n%s\n' "$line" >>"$rc"
  say "added $bin to PATH in $rc; open a new shell to run gent"
}

# Another gent earlier on PATH would run instead of this one. A bin directory
# not yet on PATH goes first in a new shell, so nothing shadows it.
report_shadow() {
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) return 0 ;;
  esac
  old_ifs="$IFS"
  IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    if [ "$dir" = "$bin" ]; then
      IFS="$old_ifs"
      return 0
    fi
    if [ -x "$dir/gent" ]; then
      IFS="$old_ifs"
      say "warning: $dir/gent comes before $bin on PATH and runs instead; remove it"
      return 0
    fi
  done
  IFS="$old_ifs"
}

# ── helpers ─────────────────────────────────────────────────────────────────

check_version() {
  case "$1" in
    "" | *[!0-9A-Za-z.+-]* | [!0-9]*) fail "\"$1\" is not a version, such as 0.2.0" ;;
  esac
}

download() {
  if [ -t 2 ]; then
    curl -fL --retry 2 --progress-bar -o "$2" "$1" || fail "could not download $1"
  else
    curl -fsSL --retry 2 -o "$2" "$1" || fail "could not download $1"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "need sha256sum or shasum to check the download"
  fi
}

remove_tree() {
  case "$1" in
    "$root"/versions/?*) rm -rf "$1" ;;
  esac
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "need $1 to install gent"
}

say() {
  printf 'gent: %s\n' "$1" >&2
}

fail() {
  printf 'gent: %s\n' "$1" >&2
  exit 1
}

main "$@"
