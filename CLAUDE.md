# herdr-serhii

A personal fork of [herdr-sab](https://github.com/thabti/herdr-sab). Upstream is the `upstream` git remote;
it installs as the `serhii` layout with `serhii-*` mods, so it can sit next to herdr-sab.

A layout plus five mods for the Herdr desktop app (plain ES modules, no build step).
User docs live in `docs/GUIDE.md`. Its §11 "How it is built" covers the file map and design notes.

## Workflow

- **Land on `main`.** Commit straight to `main` and push. Don't open feature branches or PRs unless asked.
- **Keep this file current.** Every change that adds a feature, setting, convention or gotcha updates this file in the same commit.
- **Docs move with code.** A user-visible change also updates `docs/GUIDE.md` (feature section plus the settings table) and the README's "What you get" list when it's a headline feature.
- After a change: run `scripts/install.sh`. It syncs shared files, copies the mods into `~/.config/herdr-app`, and runs `herdr-app check` on each one. Herdr hot-reloads the mods.
- To force a reload: `herdr-app do layout.switch --name serhii`. Check the result with `herdr-app status` (`"errors": []`) and `herdr-app shot <png>`. Never restart the user's app or `hc`.

## Code rules

- **Shared code.** Herdr mods can't import each other. Edit `serhii/shared/*.js` only, then run `scripts/sync-shared.sh`, which copies it into `serhii-tabs`, `serhii-panel` and `serhii-settings`. Never edit the copies.
- **Settings.**
  - A new setting gets a default in `DEFAULTS` (`serhii/shared/config.js`) with a comment.
  - Add a control in `serhii/mods/serhii-settings/main.js` (`toggle` / `stepper` / `choice` / `chips`) and a row in the GUIDE settings table.
  - Read settings through `cfg()`.
- **API reference.** `gpui-kit.d.ts` in each mod is the SDK reference (`herdr`, `gpui-kit`, `gpui-base`). It's gitignored, so grep it for an element method before using it.
- **Panels** (`serhii/mods/serhii-panel/*.js`) stay alive while hidden:
  - Gate reads on `isShown(this.id)`.
  - Capture `key()` before any await and drop the result when it changed (the user moved to another pane).
  - Pass `{ cwd, on }` to every `exec`; `on` is a remote machine or null.
  - `watchFolder` is local-only.
- **Git safety.** Commit only the listed files (`--literal-pathspecs add -A -- <paths>`), never `git add -A` on the whole tree. Pushes go through `sh -c 'GIT_TERMINAL_PROMPT=0 exec git "$@"'` so they fail instead of waiting on a hidden prompt.
- **GitHub.** Run gh through `ghAs(account, …)` with the account from `ghAccount(root, on)`, which picks the logged-in account that can see the repo.
- **Derived files.** Each one keeps its "Derived from / Modified by" header. Add a `Modified for herdr-serhii:` line when you change what it does.
- **Style.** No spinners: use slow `.loop("opacity")` dots, because `.spin()` redraws the whole window.

## Changes panel (`changes.js`)

- **Single repository:** the original Herdr/Kanso behaviour.
- **Folder that isn't a repository** (`changes.nested`):
  - `findRepos` runs `find` up to `changes.scanDepth` deep. It skips hidden folders and `node_modules`, `vendor`, `dist`, `build`, `target`, `Pods`, as well as repos nested in a found repo.
  - It rescans every 30 s and never scans `~` or `/`.
  - It caps at `changes.maxRepos` (default 100). `~/Documents/work/GitHub/mumzworld` holds 55 repos.
  - **Git calls are expensive.** Each one costs about 80 ms through macOS's `/usr/bin/git` (Xcode shim), so the number of calls matters more than what they do:
    - `readRepo` makes one `git status --porcelain=v2 --branch` call, which also gives the branch and HEAD. `diff --numstat` runs only for a dirty repo.
    - `baseOf` caches each repo's base for 5 min; `aheadOf` caches the ahead count per HEAD.
    - A watch event re-reads only its own repo. The 10 s timer does a full multi-repo read at most every 30 s.
    - On 54 repos that is 2.4 s per refresh, down from 9.4 s.
  - `readRepo` returns `{ root, name, files, branch, base, ahead }`. `target()` picks the repo for Commit and Create PR: the filter chip, else the repo of the open diff.
- **Create PR** (`createPr` in `lib.js`, also used by the PR panel):
  - Pushes the branch (`-u origin HEAD` on the first push), then runs `gh pr create --fill [--draft] --head <branch>`.
  - It returns `{ url, existed }`.
  - The button shows only when the branch isn't `defaultBranch()` and `ahead > 0`.

## Side-by-side diff (`diff.js`)

- Opened by Changes (double-click a file, or the split icon on the open row) as a dialog: `openOverlay({ mod: "serhii-panel", kind: "dialog", props: { panel: "diff", root, path, on, fresh, hasHead, status } })`. `main.js` maps `panel: "diff"` to it; it is not in the `panel-body` stack.
- One `git diff HEAD -U1000000` call gives both whole files; `sideBySide()` pairs `-`/`+` runs into rows, so one virtual list scrolls both halves.
- Gotchas: a vertical virtual list takes its width from its first row, so rows get an explicit `.w(this.width)` from the root's `on_size_change` (`w_full` rows rendered blank in the first try). `FocusHandle.focus()` throws during render: focus from a timer.
- "Whole file" vs "Changes only" persists in shared `serhii.diffWholeFile`.

## Git panel (`git.js`)

- A `panel-body` stack child (`git`), a tab-bar button (`serhii-tabs` `PANELS`), `panels.git` (on) and `git.graphLimit` (300).
- One refresh = 5 git calls: `rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD`, then `worktree list --porcelain`, `for-each-ref refs/heads`, `remote` and `log --graph` in parallel. It watches the git common dir (local), so commits, checkouts and fetches in any worktree refresh it; plus a 15 s timer.
- `log --format=%x01%h%x00%D…`: `\x01` splits the graph prefix from the fields. `parseGraph` / `parseRefs` / `parseWorktrees` are exported and pure, for Node tests.
- Read-only on purpose: no checkout or fetch from the panel.
- The Node stub for `herdr` also needs `appHome` and `writeTextFile` (config.js imports them).

## Testing without the app

There is no test suite. To exercise a panel's logic, run it in Node with stub modules:

1. Register a loader hook (`module.register`) that maps `herdr`, `gpui-kit` and `gpui-base` to stub files:
   - `exec` → `child_process.execFile` returning `{ code, stdout, stderr }`.
   - Elements → a Proxy that records `child`/`children`/`id`/`on_click`.
   - `watchFolder` → a promise that rejects.
2. Drive `init` / `refresh` / `render` against throwaway repos in the scratchpad.

Two tricks:
- **Fake GitHub:** a local bare repo plus `git config url.<bare>.pushInsteadOf https://github.com/…`, and a fake `gh` script first on `PATH`.
- **Throwaway repos under zsh:** set the `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars rather than splitting `git -c …` from a variable.

Never point a test that commits or pushes at the user's real repos.
