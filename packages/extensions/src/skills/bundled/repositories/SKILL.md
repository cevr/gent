---
name: repositories
description: Fetch and inspect external Git repositories and npm packages with their native command-line tools.
---

Use the existing `bash` tool from a cell to run commands. Keep process supervision, output receipts, and cancellation in that tool. Keep parsed results and resolved revisions in cell variables. There is no `repo` tool.

Check the required executable with `command -v` before use. Git operations need Git. Search needs `rg`. npm package downloads need npm and tar. GitHub metadata and existing GitHub CLI authentication need `gh`. If a required program is absent, report it. Do not assume a personal `okra` installation.

## Git sources

Use a caller-selected source checkout when supplied. Otherwise cache GitHub repositories under `~/.cache/repo/<owner>/<repo>`. Construct paths from the explicit owner and repository name. Quote each shell argument. Reject empty components, separators within components, and `.` or `..` components.

For a new cache, use `git clone --filter=blob:none --no-checkout -- <url> <cache>`. Existing Git credential helpers and SSH configuration own authentication. If the user already uses GitHub CLI authentication, `gh repo clone <owner>/<repo> <cache> -- --filter=blob:none --no-checkout` uses that path. Do not extract tokens or rewrite credential settings.

For an existing cache, inspect `git -C <cache> remote get-url origin` before fetching. Confirm that it is the requested repository. Use `git -C <cache> fetch --prune origin` only when current remote data is needed. Do not reset, clean, or force-checkout an existing cache.

Resolve the requested ref once with `git -C <cache> rev-parse --verify --end-of-options '<ref>^{commit}'`. Use the returned commit ID for every subsequent read and citation. For current remote HEAD, inspect `git -C <cache> ls-remote --symref origin HEAD`, fetch the named branch, and resolve its remote-tracking ref. Do not assume a local HEAD or tag is current.

- List a revision: `git -C <cache> ls-tree -r --name-only <commit>`.
- Read a text file: `git -C <cache> show '<commit>:<path>'`.
- Search a revision: `git -C <cache> grep -n -e <pattern> <commit> -- <pathspec>`.
- Search an existing working tree: `rg -n -- <pattern> <directory>`.
- Read GitHub metadata: `gh api repos/<owner>/<repo>`.

Do not pass binary file contents into model text. Inspect file type or Git attributes before reading an unknown blob. Use a temporary worktree or archive only when an external tool needs real files. Preserve the original checkout.

Treat a search exit code of 1 as no matches. Treat other nonzero codes as errors. Report stderr and the failed operation. Do not convert authentication, missing-program, or invalid-ref failures into empty results.

## npm sources

Resolve an unpinned request with `npm view <package> version --json`. Record the exact version. Cache it under `~/.cache/repo/npm/<package>/<version>`; preserve scoped package names as two path components.

Use `npm pack --ignore-scripts --json --pack-destination <temporary-directory> <package>@<version>`. Read the archive filename from the JSON reply. Inspect the archive entries, then extract into a fresh directory with `tar -xzf <archive> -C <directory>`. The package contents normally sit under `package/`. Publish the complete cache directory only after extraction succeeds. Read and search that directory with normal file operations.

Do not install the package into Gent or the cell runtime to inspect its sources. Run any requested build or behavior check in the package's own environment. Preserve failures from that environment.

PyPI and Crates require their own documented download commands. This skill does not claim a universal package-fetch API.
