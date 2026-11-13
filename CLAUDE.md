# herdr-toolkit

Public at https://github.com/SergiyShch/herdr-toolkit (`origin`), derived from [herdr-sab](https://github.com/thabti/herdr-sab)
(the `upstream` remote). It installs as the `toolkit` layout with `toolkit-*` mods, so it can sit next to herdr-sab.
Until 2026-11-09 it was herdr-serhii (`serhii` layout, `serhii-*` mods, `serhii.json`). Upstream uses `sab` names, so merges need renaming either way.

A layout plus five mods for the Herdr desktop app (plain ES modules, no build step).
User docs live in `docs/GUIDE.md`. Its §11 "How it is built" covers the file map and design notes.

## Workflow

- **Land on `main`.** Commit straight to `main` and push. Don't open feature branches or PRs unless asked.
- **Keep this file current.** Every change that adds a feature, setting, convention or gotcha updates this file in the same commit.
- **Docs move with code.** A user-visible change also updates `docs/GUIDE.md` (feature section plus the settings table) and the README's "What you get" list when it's a headline feature.
- After a change: run `scripts/install.sh`. It syncs shared files, copies the mods into `~/.config/herdr-app`, and runs `herdr-app check` on each one. Herdr hot-reloads the mods.
- To force a reload: `herdr-app do layout.switch --name toolkit`. Check the result with `herdr-app status` (`"errors": []`) and `herdr-app shot <png>`. Never restart the user's app or `hc`.

## Code rules

- **Shared code.** Herdr mods can't import each other. Edit `toolkit/shared/*.js` only, then run `scripts/sync-shared.sh`, which copies it into `toolkit-tabs`, `toolkit-panel` and `toolkit-settings`. Never edit the copies.
- **Settings.**
  - A new setting gets a default in `DEFAULTS` (`toolkit/shared/config.js`) with a comment.
  - Add a control in `toolkit/mods/toolkit-settings/main.js` (`toggle` / `stepper` / `choice` / `chips`) and a row in the GUIDE settings table.
  - Read settings through `cfg()`.
- **API reference.** `gpui-kit.d.ts` in each mod is the SDK reference (`herdr`, `gpui-kit`, `gpui-base`). It's gitignored, so grep it for an element method before using it.
- **Panels** (`toolkit/mods/toolkit-panel/*.js`) stay alive while hidden:
  - Gate reads on `isShown(this.id)`.
  - Capture `key()` before any await and drop the result when it changed (the user moved to another pane).
  - Pass `{ cwd, on }` to every `exec`; `on` is a remote machine or null.
  - `watchFolder` is local-only.
- **Git safety.** Commit only the listed files (`--literal-pathspecs add -A -- <paths>`), never `git add -A` on the whole tree. Pushes go through `sh -c 'GIT_TERMINAL_PROMPT=0 exec git "$@"'` so they fail instead of waiting on a hidden prompt.
- **GitHub.** Run gh through `ghAs(account, …)` with the account from `ghAccount(root, on)`, which picks the logged-in account that can see the repo.
- **Derived files.** Each one keeps its "Derived from / Modified by" header. Add a `Modified for herdr-toolkit:` line when you change what it does.
- **Virtual lists** (`v_virtual_list`): no `on_click` (or any handler) inside the row renderer — it throws and the whole list draws blank, with nothing in `herdr-app status`. Use `.on_item_click((key, cx) => …)` on the list; `key` is what `get_key(i)` returned.
- **Style.** No spinners: use slow `.loop("opacity")` dots, because `.spin()` redraws the whole window.

## Changes panel (`changes.js`)

- **Single repository:** the original Herdr/Kanso behaviour.
- **Folder that isn't a repository** (`changes.nested`):
  - `findRepos` runs `find` up to `changes.scanDepth` deep. It skips hidden folders and `node_modules`, `vendor`, `dist`, `build`, `target`, `Pods`, as well as repos nested in a found repo.
  - It rescans every 30 s and never scans `~` or `/`.
  - It caps at `changes.maxRepos` (default 100). A work folder of 55 repos is the benchmark below.
  - **Git calls are expensive.** Each one costs about 80 ms through macOS's `/usr/bin/git` (Xcode shim), so the number of calls matters more than what they do:
    - `readRepo` makes one `git status --porcelain=v2 --branch` call, which also gives the branch and HEAD. `diff --numstat` runs only for a dirty repo.
    - `baseOf` caches each repo's base for 5 min; `aheadOf` caches the ahead count per HEAD.
    - A watch event re-reads only its own repo. The 10 s timer does a full multi-repo read at most every 30 s.
    - On 54 repos that is 2.4 s per refresh, down from 9.4 s.
  - `readRepo` returns `{ root, name, files, branch, base, ahead }`. `target()` picks the repo for Commit and Create PR: the filter chip, else the repo of the file last opened (`this.open`).
- The panel is only the file list: a click opens the side-by-side dialog (`diff.js`); there is no diff under the list.
- New (untracked) files get their `+N` from one `wc -l` call per repo (`countNew`, up to 200 files).
- **Create PR** (`createPr` in `lib.js`, also used by the PR panel):
  - Pushes the branch (`-u origin HEAD` on the first push), then runs `gh pr create --fill [--draft] --head <branch>`.
  - It returns `{ url, existed }`.
  - The button shows only when the branch isn't `defaultBranch()` and `ahead > 0`.

## Side-by-side diff (`diff.js`)

- Opened by Changes (a click on a file) as a dialog: `openOverlay({ mod: "toolkit-panel", kind: "dialog", props: { panel: "diff", root, path, on, fresh, hasHead, status } })`. `main.js` maps `panel: "diff"` to it; it is not in the `panel-body` stack.
- One `git diff HEAD -U1000000` call gives both whole files; `sideBySide()` pairs `-`/`+` runs into rows, so one virtual list scrolls both halves.
- Gotchas: `scroll_to_item` in the same frame the list's row count changes leaves it blank (Whole file was empty): jump from a timer (`goSoon`). A vertical virtual list takes its width from its first row, so rows get an explicit `.w(this.width)` from the root's `on_size_change` (`w_full` rows rendered blank in the first try). `FocusHandle.focus()` throws during render: focus from a timer.
- "Whole file" vs "Changes only" persists in shared `toolkit.diffWholeFile`.
- Sideways scroll is the dialog's own `this.dx`, not an overflow area (that would slide the right half off screen): each half's text is `ml(-dx)` inside an `overflow_hidden` box, so line numbers stay. `on_scroll_wheel` on the list's wrapper takes `delta.x`; the bar under the rows is drawn by hand (`grab`, then `on_mouse_move`/`on_mouse_up` on the root). Its range comes from the longest line × `CH` (7.25 px, the 12 px monospace advance), since the SDK can't measure text.
- Changes passes `files` (its shown list, in order); `go()` past the last/first change calls `show(k, "first"|"last")` for the next/previous file, wrapping. `load`/`watch` drop results once the dialog moved to another file.

## Git panel (`git.js`)

- A `panel-body` stack child (`git`), a tab-bar button (`toolkit-tabs` `PANELS`), `panels.git` (on) and `git.graphLimit` (300).
- One refresh = 5 git calls: `rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD`, then `worktree list --porcelain`, `for-each-ref refs/heads`, `remote` and `log --graph` in parallel. It watches the git common dir (local), so commits, checkouts and fetches in any worktree refresh it; plus a 15 s timer.
- `log --format=%x01%h%x00%D…`: `\x01` splits the graph prefix from the fields. `parseGraph` / `parseRefs` / `parseWorktrees` are exported and pure, for Node tests.
- Tabs (`this.tab`, shared `toolkit.gitTab`): Graph · Branches · Worktrees (the last only with more than one). `reveal()` switches to Graph and scrolls a frame later. The commit card takes up to 45% of the panel's height (`on_size_change`).
- Graph scopes (`this.scope`, shared `toolkit.gitScope`; the old value `current` reads as `head`): `all` (`--branches --remotes --tags HEAD`), `head` (`HEAD`), `branch` (`origin/<base>..HEAD`, base from `defaultBranch`, cached 5 min). `own` = `rev-list origin/<base>..HEAD` (full hashes, matched against `%H`) tints those rows; the fork point is `merge-base HEAD origin/<base>`.
- No checkout or fetch from the panel. Its one write is **deleting a local branch** (Branches tab):
  - The bin shows on hover (`on_hover` → `this.hovered`), not on the current branch or one in another worktree.
  - `this.del` = `{ name, state: "ask" | "busy" | "unmerged" | "error" }` swaps the row for `deleteRow`. It runs `git branch -d`; stderr `not fully merged` offers "Delete anyway" (force).
  - Success parses `(was <sha>)` into `this.deleted` for **Undo** (`git branch <name> <sha>`). Both reset on a context change.
  - Buttons inside a row stop the press on `on_mouse_down` and in `on_click`, or the row's own click (reveal in the graph) fires too.
  - The Claude Code git-guardrails hook blocks any shell command containing the force-delete flag, even in scratch repos and doc edits: test the `-d` path, edit docs with the Edit tool.
- A click on a commit: `git show --format= --no-renames --diff-merges=first-parent` with `--name-status -z` and `--numstat -z` (`parseCommitFiles`), listed under the graph. A file opens `diff.js` with `rev`: it diffs with `git show -U1000000 <rev> -- path` (works for root commits; merges against the first parent) and doesn't watch.
- The Node stub for `herdr` also needs `appHome` and `writeTextFile` (config.js imports them).

## GitHub accounts (`gh.js`, `lib.js`)

- `ghAccount(root, on, space = location().space)` → `{ repo, account, pinned }`. `pinFor` order: `github.repos` (`pinned: "repo"`), `github.spaces[<space id>]` (`"space"`), `github.accounts` by owner (`"owner"`), else the automatic probe (cached in shared `toolkit.gh.accounts`).
- `githubRepo` reads `origin` with `parseRemote` (pure): `github.com`, or an ssh alias (`git@github-work:o/n`) whose `ssh -G` HostName is `github.com`, cached per machine. Many remotes here use such aliases; a `github.com`-only regex silently skips every account rule for them.
- The PR/Issues account menu (`accountPicker`) links the **active space** (`linkSpace`) and then locks: a linked space shows only its login and **Unlink** (settings → GitHub too). Repository pins are set in settings only (the menu can unpin the shown one). The trigger shows `pinFor` from current settings, not the panel's last read.
- Panels store `accountKey()` (active space + `cfg().github`) on each `refresh` and read again in `render` when it differs: a link, an unpin or a space switch rereads even when `key()` (cwd + machine) didn't change, and a `reload` dropped because a read was running still happens.
- "Log in to another account…": `addGhAccount(space, { link, on, cx, done })` snapshots `gh auth status`, opens the `gh auth login` tab, then polls every 3 s (`cx.sleep`; mods have no `setTimeout`) for up to 10 min. It links the first new login, else one that became active.
- Create PR pushes an `https` origin as the account: `GIT_AS` sets `GH_TOKEN` and swaps in `!gh auth git-credential` as the only credential helper (gh's helper honours `GH_TOKEN`). Terminals are untouched: the SDK can't set env per space.

## gcloud per space (`gcloud.js`, `gcloud-menu.js`, `shell/space-env.zsh`)

- `gcloud.spaces`: space id → configuration name. `toolkit-tabs` reads the shown space's configuration with `--configuration=<name>` on every gcloud call; `gcloudKey()` (space + its configuration) is compared in `render`, so a switch of space or a link rereads.
- The chip's click opens `gcloud-menu.js` as a `toolkit-panel` popup (`props: { panel: "gcloud" }`) under the chip, not a `Popover`: the 42 px tab bar would clip one. The menu links/unlinks itself (settings) and sends the rest to the tab bar: `run("toolkit-tabs.gcloud-login" | "gcloud-new" | "gcloud-refresh")`.
- "New configuration…": `newGcloudConfig` runs an `sh` script in a new tab (name, `configurations create --no-activate`, `auth login --configuration`, project); `toolkit-tabs.gcloudNew` polls `gcloudConfigs()` (3 s, 10 min) and links the first new one with an account. The tab bar does the waiting because the popup closes.
- Terminals: `toolkit/shell/space-env.zsh` → `~/.config/herdr-app/toolkit-space-env.zsh` (install.sh copies it, prints the `~/.zshrc` line when missing; never edits `~/.zshrc`). `hc get --json $HC_TERMINAL_ID` has the `herdr.space` label already at shell start; `jq` reads `toolkit.json`. Only new shells see a change.

## Tab bar wrapping (`toolkit-tabs`)

- With `tabs.wrap` (on) the tabs sit in a `flex_wrap` row; its `on_size_change` height is the bar's height, applied with `layout.resize { id: "tabs", px }` (never under 42, the layout's one-row size). The root is `items_start` so that row measures its content, not the block.
- The SDK has `gap_x`/`gap_y`, not `row_gap`.

## Editor button

- Drops `toolkit-open-with` down under itself: `openOverlay({ kind: "popup", at: { x, y } })` from the button's `bounds` (taken on mouse down), right edges aligned. `⌘⇧O` (keys.json `mod.open`) still uses mod.json's `at: "top"`.

## PR panel look (`pr.js`)

- Every section is `card(c)` (bordered, `c.card` = theme `raised`) with `section()` as its header band; `block()`/the card's inner `v_flex().px(G.md).py(G.sm)` pads the content. The top of the PR is a card too: branch chips, a verdict badge, stat tiles, then the actions.
- Actions are `pill()` (bordered buttons); `quietLink()` stays for "Show more" and the like.

## Diff colours

- Changed lines use the theme's ANSI hue at alpha `78` (≈47%): the theme's greens and reds are muted, so lower alphas barely show on dark. The side-by-side dialog marks the differing part at `c8`.

## Testing without the app

There is no test suite. To exercise a panel's logic, run it in Node with stub modules:

1. Register a loader hook (`module.register`) that maps `herdr`, `gpui-kit` and `gpui-base` to stub files:
   - `exec` → `child_process.execFile` returning `{ code, stdout, stderr }`.
   - Elements → a Proxy that records `child`/`children`/`id`/`on_click`. Its `when(cond, fn)` must call `fn` when `cond` is truthy, or most of a panel is never built; make handlers throw while a `v_virtual_list` renderer runs, as the SDK does.
   - `watchFolder` → a promise that rejects.
2. Drive `init` / `refresh` / `render` against throwaway repos in the scratchpad.

Two tricks:
- **Fake GitHub:** a local bare repo plus `git config url.<bare>.pushInsteadOf https://github.com/…`, and a fake `gh` script first on `PATH`.
- **Throwaway repos under zsh:** set the `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars rather than splitting `git -c …` from a variable.

Never point a test that commits or pushes at the user's real repos.
