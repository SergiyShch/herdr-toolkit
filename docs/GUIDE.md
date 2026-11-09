# herdr-toolkit guide

This guide covers everything herdr-toolkit adds to Herdr, how to use it day to day, every setting, and what to do when something looks wrong.

- [1. Install and remove](#1-install-and-remove)
- [2. A tour of the window](#2-a-tour-of-the-window)
- [3. The side panel](#3-the-side-panel)
- [4. Tabs that name themselves](#4-tabs-that-name-themselves)
- [5. Claude Code context](#5-claude-code-context)
- [6. gcloud login](#6-gcloud-login)
- [7. Open in editor](#7-open-in-editor)
- [8. Workflows](#8-workflows)
- [9. Settings](#9-settings)
- [10. Troubleshooting](#10-troubleshooting)
- [11. How it is built](#11-how-it-is-built)

---

## 1. Install and remove

**Requirements**

| Tool | For | Needed? |
|---|---|---|
| Herdr desktop app | everything | yes |
| `git`, `python3` | Files, Changes, the installer | yes |
| `gh`, signed in (`gh auth login`) | PR and Issues panels | for those panels |
| `gcloud` | the gcloud chip (hidden when missing) | optional |
| A Claude Code status line that saves a snapshot | context % on tabs | optional ([§5](#5-claude-code-context)) |

**Install**

```sh
cd herdr-toolkit
scripts/install.sh --dry-run
scripts/install.sh
herdr-app do layout.switch --name toolkit
```

The installer:

- copies `toolkit/layouts/toolkit.json` to `~/.config/herdr-app/layouts/`;
- copies the mods `toolkit-tabs`, `toolkit-panel`, `toolkit-open-with`, `toolkit-settings` and `toolkit-chrome` to `~/.config/herdr-app/mods/`;
- adds four keys to the `layout:toolkit` section of `keys.json`;
- runs `herdr-app check` on each mod.

It refuses to overwrite a mod or layout of the same name that it didn't install. It marks its own mods with a `.herdr-toolkit` file.

**Update.** `git pull && scripts/install.sh`. Herdr reloads the mods live.

**Switch back.** Press `ctrl-shift-l`, or pick another layout in Herdr's Settings → Look.

**Remove.** `scripts/install.sh --remove` deletes the layout, the five mods and the four keys. Your settings file `~/.config/herdr-app/toolkit.json` stays; delete it by hand if you like.

`HERDR_APP_HOME=/path scripts/install.sh` installs into another Herdr home.

---

## 2. A tour of the window

`toolkit` is Herdr's own `main` layout with these changes:

```
┌──────────┬──────────────────────────────────────────────────────────────────┐
│ Spaces   │ [tabs…]  +  │ ☁ ● project ↪ │ ⧉  Files Changes Git PR Issues ⚙   │
│          ├───────────────────────────────────────────────┬──────────────────┤
│          │                                               │                  │
│ Agents   │              your panes                       │   side panel     │
│          │                                               │   (on demand)    │
│──────────│                                               │                  │
│ Settings │                                               │                  │
│ herdr-toolkit│                                               │                  │
│ settings │                                               │                  │
│ Add mach.├───────────────────────────────────────────────┴──────────────────┤
│          │ status bar                                                       │
└──────────┴──────────────────────────────────────────────────────────────────┘
```

Tab bar, left to right:

| Piece | What it does |
|---|---|
| Tabs | Self-naming ([§4](#4-tabs-that-name-themselves)). A Claude tab shows its context %. Click selects, drag reorders, double-click names, right-click opens Herdr's tab menu. Tabs that don't fit wrap onto a new row and the bar grows (settings → Tabs; off, they scroll and the mouse wheel moves between tabs). |
| `+` | Herdr's new-tab menu: a shell or any installed agent |
| ☁ ● project | gcloud chip: click for the space's gcloud configuration ([§6](#6-gcloud-login)) |
| ↪ | `gcloud auth login` |
| ⧉ | Open in editor ([§7](#7-open-in-editor)) |
| Files · Changes · Git · PR · Issues | Toggle the side panel ([§3](#3-the-side-panel)) |
| ⚙ | herdr-toolkit settings ([§9](#9-settings)) |

---

## 3. The side panel

Click a panel button to show it, and click it again to close it. The panel is 420 px wide; drag its left edge to resize it (300–900 px). **Each space remembers its own panel**: switching spaces brings back the one that space had open, or none.

**Every panel follows the focused pane's folder.** Click into a pane in another repository and the panel switches to it. That is what makes GitHub per session.

A hidden panel does no work: it doesn't run git or `gh` and catches up when you show it again.

**Several GitHub accounts.** If you're logged in to `gh` with more than one account (`gh auth status`), for example a personal one and a work one, the PR and Issues panels pick the right one **for each repository**. They try `gh`'s active account first, then each other login, and remember the first one that can see the repository. The footnote names the account used ("Read from GitHub with gh as …"). 

**An account for each space.** The PR and Issues headers show the account in use: an initial and a login, with a lock when the space is linked (a pin when the repository has its own). Click it for the account menu of the space you're in:

- **A login**: link the space to it and lock it there. Every repository the PR and Issues panels read in this space then uses that account (`github.spaces` in `toolkit.json`, keyed by the space's id).
- Once linked, the menu shows only that login, with a lock, and **Unlink from …**. Unlink to pick another one; until then nothing else is offered. When nothing is linked a row reads **Automatic** and says which account it found.
- **Log in to another account…** runs `gh auth login` in a new tab and waits (up to 10 minutes) for the login to show up in `gh auth status`. It then links the space to it on its own and tells you so. A login you had before counts too: `gh` makes it active, and that's what gets linked. `gh` makes the new account its active one, as `gh auth login` always does.
- **Unpin owner/name** shows when the repository has its own pin, which wins over the space.
- **Account settings…** opens settings → GitHub. It lists every login with **Make active** (`gh auth switch`, so your terminals' `gh` uses it too), every space on this computer (an unlinked one gets a choice of logins; a linked one shows its lock and **Unlink**), links to spaces that are gone, to unlink, and the pinned repositories.

An `origin` behind an ssh alias (`git@github-work:org/repo`, with `HostName github.com` in `~/.ssh/config`) counts as GitHub too.

Which account reads a repository, in order: its pin (`github.repos`, settings → GitHub → Pinned), the space's account, the owner's pin (`github.accounts`, `{"my-org": "login"}`, only in `toolkit.json`), then automatic. The token is read inside a shell (`GH_TOKEN=$(gh auth token -u …)`), so it never appears in a process list. Your active `gh` account doesn't change, and neither do your terminals: this is for the panels (and Create PR) only.

### Files

- A tree of the focused pane's folder. It loads lazily, folder by folder, up to 500 entries per folder and 5,000 in total.
- Git marks beside each file: `A` added or untracked, `M` modified, `D` deleted, `U` conflict.
- Click a file to preview it: Markdown is rendered, and code is shown read-only with syntax colors. Press ← to go back to the tree.
- **Right-click** a file, or use the button at the top right, to open it in an editor or in the **Preview** panel.
- It refreshes on every save in that folder, and every 10 s.

### Changes

- Every uncommitted change in the repository, with `+added −removed` per file and in total.
- A new (untracked) file counts its lines as additions.
- **Click a file** to compare it side by side in a large dialog, as an IDE does: the last commit (HEAD) on the left, the working tree on the right, scrolling together. Changed lines are blue, with the part that differs marked; removed lines red, added lines green. Unchanged runs fold away (click a fold to show it); the **Changes only / Whole file** button switches modes and is remembered. **F7** / **Shift+F7** (or ↓ / ↑) jump between changes, and past a file's last change on to the next file of the Changes list (before its first, to the previous one), so you can read through every change without closing the dialog. It reads the file again on every save. Esc closes it.
- **Commit** commits only the files listed, never `git add -A` on the whole tree. You can turn committing off in settings.
- **Create PR** sits beside **Commit** when the branch isn't the base (origin's default branch) and has commits the base doesn't. It pushes the branch (`-u origin HEAD` the first time) and runs `gh pr create --fill`, as a draft by default, with the gh account the panels use for the repository (an `https` push uses that account's token, not the keychain's). Its title and body come from the commits. When the branch already has one, it says so and links it. In a single repository it then switches to the PR panel.
- **A folder of repositories.** When the pane's folder isn't a repository but holds several (`~/work/client/api`, `~/work/client/web`…), the panel finds them (up to 100), up to 2 folders deep (hidden folders, `node_modules`, `vendor`, `dist`, `build` and `target` are skipped), and shows one section per repository with its branch and `+added −removed`. Click a section's header to fold it.
  - The chips under the title filter the list: **All**, or one repository. Repositories without changes are left out of **All**.
  - **Commit** and **Create PR** go to one repository: the one picked in the chips, else the one of the file you last opened. The line above the message says which. A repository with no changes but commits ahead of its base (`↑2`) still shows, ready for its pull request.
  - Turn it off, or look deeper, in settings → Panels.

### Git

The repository of the pane you're in, at a glance. It only reads git: it never checks out, fetches or changes anything.

- **The checked-out branch** sits in the header (or `detached`).
- Three tabs under it, each with the panel's full height: **Graph**, **Branches** (with a count) and **Worktrees** (only when there is more than one). The tab you used last is remembered.
- **Worktrees** (when there is more than one): each with its branch and folder; the pane's own is highlighted. Click another to open a new tab in it.
- **Branches**: local branches, newest first, the checked-out one on top (●). `◐` marks a branch checked out in another worktree. `↑2 ↓1` is how far it is ahead of and behind its upstream; `gone` means its upstream was deleted. Click a branch to switch to the graph with its tip marked.
- **Graph**: `git log --graph` with a label per branch (the checked-out one is `● name`, remote ones blue, tags yellow). Hover a commit for its author and full subject. Three scopes:
  - **All branches**: every local and remote branch and tag, so forks and merges show as lines.
  - **This branch**: the checked-out branch's whole history, including what it inherited from its base.
  - **Since dev** (named after the base, origin's default branch): only the branch's own commits, the ones a pull request would hold, with where it forked at the bottom.
  - In the first two, the branch's own commits are tinted and the line under the scopes says how many there are.
- **Click a commit** to open a card under the graph (marked COMMIT) listing its files (status and `+added −removed`, against its first parent). Click a file to open it side by side as in Changes: the parent (`abc123^`) on the left, the commit on the right; the arrows walk on through the commit's other files. Click the commit again, or ×, to close the list.
- It reads again on every commit, checkout, fetch or branch change (the repository's git folder, on this computer), and every 15 s.

### Pull requests (PR)

The panel shows **one pull request**: the current branch's own. If the branch has none, it shows the newest open one in the repository and says so.

**N open ›** (top right) turns the panel into a list of every open pull request, grouped as **This branch**, **Yours** and **Others**. Each row shows its state (draft, checks failing, changes requested, checks running, approved, waiting for review, checks passed) and its size. Click a row to show it, and press **Back to #n** to return. Row actions (they can be turned off):

- ↗ opens it in the browser;
- **Review** and **Describe** start those agent tasks for that pull request.

The pull request view, top to bottom:

| Section | Contents |
|---|---|
| Header | `#n · head → base`, title, verdict (ready to merge, conflicts, checks failing, …), author and age; its **labels** (with a picker) and the **Jira ticket** its title or branch names (click to open); files / added / removed / threads / comments / checks counts |
| Actions | **Merge**: press twice within 4 s; uses the repository's allowed method, or the one you set. **Ready for review / Back to draft**, **Close** (or **Reopen**) |
| Description | The body as Markdown, folded when long |
| People | Assignees (plus **Assign to me**) and reviewers with their verdicts. Each has a picker: search, click to add or remove |
| Checks | Failing first; click one to open its page |
| Unresolved threads | First comment, `path:line`, author, replies; click to open it on GitHub |
| Comments | The conversation on the pull request: the latest 5 (**Show earlier** for the rest), author and age; click one to open it on GitHub |
| Ask your agent | **Code review**, **Describe change**, **Explain it**, **Address feedback**, **Resolve conflicts** (only when it conflicts) |
| Files | Changed files; click one to see its diff inline |

Header buttons: refresh, copy the link, open on GitHub. If the branch has no pull request, **Create pull request** pushes it and runs `gh pr create --fill` (a draft by default), then shows the new one.

The panel rereads every 60 s while shown (configurable), and every 20 s while a check is running.

### Issues

Off by default: turn it on in settings → Panels.

- The repository's open issues: the 100 most recently updated by default (configurable).
- Groups: **This branch** (its name carries the issue number), **Assigned to you**, **Opened by you**, **Everyone else**.
- Each row: title, `#n · author · updated · comments · milestone`, assignees and labels.
- **Click a row** to open the issue in your browser.
- **Start** opens a new tab named `#n` running your agent ([§9](#9-settings) → Agent tasks), with the issue as its first message. The default prompt asks the agent to read the issue, plan, and work on a branch named after it, without pushing.
- The filter box matches title, number, label or author.
- ↗ at the top opens the repository's issues page.

### Preview

One file, rendered: Markdown is drawn, anything else shown as read-only code. It reloads whenever the file changes, so you can watch an agent write a plan or a doc. Open it from **Open with → Preview in the panel**, on any text file.

---

## 4. Tabs that name themselves

A tab **you haven't named** is named by the first rule that matches:

1. **The issue key** in its pane's branch or folder:
   - Jira-style `WEB-142` anywhere, e.g. `feature/WEB-142-login` or `client-portal-WEB-142`.
   - A GitHub number at the start of a branch name or a path segment: `123-fix-login`, `fix/123-login`, `issue-123`, `gh-123` → `#123`. Off by default (settings → Tab bar).
2. **The agent's own title.** Claude Code titles its terminal with the conversation's name. The status glyph in front (`✳`, braille spinners) is dropped, and generic titles like "Claude Code", shell names or paths are ignored.
3. **The program's name**, e.g. "zsh" or "Claude Code".

Hover a tab to see the full name, such as `WEB-142 · Fix the login redirect`.

**A name you type always wins.** Double-click the tab or press `F2`. To go back to the automatic name, rename the tab to nothing.

Tabs that herdr-toolkit creates (agent tasks, issue **Start**) get names such as `#214 Review` or `#123`. These count as typed names, so they don't change.

Nothing is written to Herdr: automatic names are only drawn, so other layouts show Herdr's own names.

Settings: turn automatic names off, or choose the sources (Jira keys, GitHub numbers, agent title).

**Open the Jira ticket.** Set your Jira site in settings → Tab bar (for example `https://your-site.atlassian.net`); it's empty by default, and the links only appear once it's set. Then every Jira key herdr-toolkit shows becomes a link to `https://your-site.atlassian.net/browse/DS-1234`:

- **Tabs**: a key in the tab's name, its agent's title, its branch or its folder gives the active tab a ticket button; `⌘⌥J` opens it.
- **Pull requests**: chips for keys in the title or branch, in the header and on each row of the open list; keys in the description become links; chips under comments and review threads that mention one.
- **Issues**: chips for keys in an issue's title.
- **Markdown** in Files and Preview: keys become links.

One pattern finds them all: two to ten capitals and digits starting with a letter, a dash, a number (`DS-1234`, `WEB2-7`). Lookalikes such as `UTF-8`, `SHA-256` or `ISO-8601` are skipped. For no false matches at all, list your projects in settings → Tab bar → **Projects** (`DS, WEB`): then only those count, and lowercase `ds-1234` in branch and folder names counts too.

---

## 5. Claude Code context

A Claude Code tab shows a small `42%`: how full that conversation's context window is.

- It turns **red** at 80% or more (configurable).
- It is **dimmed** when the agent is idle or the reading is more than 10 minutes old (configurable). The tooltip shows the age, e.g. `Context 42% used, 58% left · of 1000k tokens · Opus 5.5 · last reading 6 min ago`.

**Where the number comes from.** Claude Code reports context only to its **status line**. herdr-toolkit reads a snapshot of what the status line receives: a file named `claude-statusline.json` in one of the snapshot folders (default `~/.harp` and `~/.local/state/herdr/plugins/herdr-agent-usage`).

If you don't have such a status line, add one to `~/.claude/settings.json`. This one saves the snapshot and prints nothing:

```json
{
  "statusLine": {
    "type": "command",
    "command": "mkdir -p \"$HOME/.harp\" && cat > \"$HOME/.harp/claude-statusline.json.$$\" && mv -f \"$HOME/.harp/claude-statusline.json.$$\" \"$HOME/.harp/claude-statusline.json\""
  }
}
```

If you already have a status line, add a `tee` of its input to that file. If you use herdr-agent-usage, its folder is already a default.

**How a reading finds its tab.** The snapshot holds only the conversation that drew last, so herdr-toolkit checks it every 3 s and **keeps the last reading of every conversation** (by `session_id`). A reading belongs to a Claude Code pane when:

1. the pane's title matches the conversation's name; or
2. that pane is the only Claude Code pane in the reading's folder.

Otherwise the tab shows nothing rather than guess. A conversation shows a figure only after its status line has run once while Herdr was open.

---

## 6. gcloud login

The chip shows `☁ ● my-project`:

| Dot | Meaning |
|---|---|
| green | logged in, and the login still works |
| red | not logged in, or the login expired (for example, your organisation requires reauthentication) |
| grey | checking |

The tooltip shows the account, the project, any configured account that differs, and when it last checked. **Click the chip** for its menu (below); **Check again** is there.

**↪** (or `⌘⌥G`) opens a tab named "gcloud login" running `gcloud auth login` (with `--configuration <name>` in a linked space). Finish in the browser, and the chip turns green within about 10 s: it checks every 10 s for 3 minutes after a login starts. Close the tab when you're done.

What it runs: `gcloud config list` and `gcloud auth list` every 2 minutes. If **Check the login still works** is on, it also runs `gcloud auth print-access-token` every 10 minutes. That command uses the network, and it is the only check that catches an expired session. If `gcloud` isn't installed, the chip doesn't show.

Settings: the chip can show the project, the account, or just the dot. You can also change the intervals, turn off the token check, and change the login command (for example `auth login --update-adc` to refresh application-default credentials too).

**A gcloud configuration for each space.** A gcloud [configuration](https://cloud.google.com/sdk/docs/configurations) is a named account and project. The chip's menu sets one per space:

- **A configuration**: lock the space to it (`gcloud.spaces` in `toolkit.json`, keyed by the space's id). The chip then reads that configuration (`--configuration`) and shows a lock. Once locked, the menu offers only **Log in again…** and **Unlink from …**.
- **Automatic** (nothing linked): gcloud's active configuration, which is global, as before.
- **New configuration…** opens a tab that asks for a name (the space's name by default), runs `gcloud config configurations create <name> --no-activate`, `gcloud auth login --configuration <name>`, then asks for a project. As soon as the new configuration has an account, the space is locked to it and a notification says so. The tab bar waits up to 10 minutes.
- Settings → gcloud lists every space on this computer with its configuration, and **Unlink**.

**Terminals.** New terminals in a linked space get `CLOUDSDK_ACTIVE_CONFIG_NAME=<name>`, so `gcloud` there, and any agent started there, uses that space's configuration. Other spaces keep theirs, and gcloud's global active configuration doesn't change. It takes one line at the end of `~/.zshrc` (the installer prints it when it's missing):

```zsh
[[ -r ~/.config/herdr-app/toolkit-space-env.zsh ]] && source ~/.config/herdr-app/toolkit-space-env.zsh
```

The snippet (`toolkit/shell/space-env.zsh`, installed to the app home) asks `hc` which space the terminal is in (`HC_TERMINAL_ID`, the `herdr.space` label) and reads `toolkit.json` with `jq`. It runs once, when the shell starts (about 10 ms), so a link reaches **new** terminals: restart a terminal (and the agent in it) to pick it up. Outside Herdr, or without `jq`, it does nothing. Application-default credentials (`--update-adc`) are global in gcloud and stay so.

---

## 7. Open in editor

The Finder button (left of **Editor**) opens the focused pane's folder in Finder. It's greyed out for a pane on another machine.

`⌘⇧O`, the **Editor** button in the tab bar, or **Open with…** in Files and Preview opens a small list of the editors installed on this Mac (the **Editor** button drops it down right under itself):

- Cursor, VS Code (and Insiders), Windsurf, Antigravity, Kiro, Trae, VSCodium, Positron, Zed, Sublime Text, IntelliJ IDEA, WebStorm, PyCharm, GoLand, PhpStorm, RubyMine, RustRover, CLion, Rider, Fleet, Nova, BBEdit, TextMate, Xcode;
- in a split: Neovim, Helix, Vim.

The one you used last comes first. Press **Enter** or click to open, **1–9** to pick directly, or **Esc** to leave. For a text file, **Preview in the panel** is offered first.

For a space on another machine, the VS Code family and Zed open over SSH; the others show "local only".

---

## 8. Workflows

**Review a teammate's pull request**

1. Click into a pane in the repository and open **PR**.
2. Click **N open ›** and pick theirs, or click **Review** on its row.
3. A tab named `#214 Review` starts your agent with the review task. Read its findings there.
4. Back in the panel: check the checks and threads, then **Merge** (press it twice).

**Write your own pull request's description**

On your branch, open **PR** and click **Describe change**. The agent drafts the description and shows it to you. Once you approve, it updates GitHub with `gh pr edit`.

**Pick up an issue**

Open **Issues**, find the issue (type in the filter), and click **Start**. A tab named `#123` starts your agent on it. The agent creates a branch like `123-short-slug`, so tabs and Issues then recognise it as **This branch**.

**Fix review feedback**

On the branch, open **PR** and click **Address feedback**. The agent fetches the unresolved threads and failing checks and works through them.

**Your gcloud session expired mid-task**

The chip turns red. Click ↪, sign in, and the chip turns green.

**Watch an agent write a doc**

Right-click the file in **Files** → **Preview in the panel**. It refreshes as the agent writes.

---

## 9. Settings

Open **herdr-toolkit settings** from:

- the tab bar's ⚙;
- `⌘⌥,`.

It looks like Herdr's own Settings and saves as you click. There is no Save button.

> **Why not inside Herdr's Settings?** Herdr's Settings window has a fixed list of sections and is rewritten on every start, so a mod can't add a section to it. herdr-toolkit settings is its sibling and links back (**Herdr settings…**).

### Every setting

| Page | Setting | Default | Notes |
|---|---|---|---|
| **Tab bar** | Name tabs automatically | on | Off: Herdr's own names |
| | Use: Jira keys · GitHub #123 · Agent title | Jira and agent title on | chips |
| | Jira site | none | e.g. `https://your-site.atlassian.net`; every DS-1234 shown links to `<site>/browse/DS-1234` |
| | Projects | any | `DS, WEB`: only these keys count; lowercase in branches too |
| | Open in Finder | on | the focused pane's folder |
| | Open in editor | on | `⌘⇧O` works either way |
| | Labels beside icons | on | Off: icons only |
| | Wrap tabs onto more rows | on | the bar grows a row at a time; off: tabs scroll sideways |
| **Panels** | Files · Changes · Git · Pull requests · Issues | Issues off | chips; off: no button |
| | Commit from Changes | on | |
| | Create PR from Changes | on | push + `gh pr create --fill` |
| | Create pull requests as drafts | on | Changes and PR panels |
| | Git graph shows | 300 commits | 100 to 2000, in any of the three scopes |
| | Repositories in subfolders | on | a folder that isn't a repository shows each one inside it |
| | Look for them | 2 deep | 1 to 5 folders below the pane's folder |
| | Pull request sections | all on | Description · People · Checks · Threads · Comments · Agent · Files |
| | Merge with | Repo default | Squash · Merge · Rebase |
| | Actions on the open list | on | ↗, Review, Describe |
| | Issues: show up to | 100 | 25–500 |
| **GitHub** | Logged in to gh | — | every login; **Make active** (`gh auth switch`), **Add…** (`gh auth login`) |
| | Account for each space | Automatic | every space on this computer: Automatic or a login, then locked until **Unlink**; the panels' account menu sets it |
| | Find it automatically | on | first account that can see the repository |
| | Pinned | none | `owner/name=login, …`; wins over the space's account |
| **Agent tasks** | Start tasks with | Claude Code | any installed agent, or the first installed |
| | Tasks | all on | Code review · Describe change · Explain · Address feedback · Resolve conflicts · Start on issue |
| | Prompts | built-in | file only, see below |
| **Claude context** | Show context on tabs | on | |
| | Warn from | 80% | 50–100 |
| | Snapshot folders | `~/.harp`, herdr-agent-usage's | comma separated |
| **gcloud** | Show gcloud login | on | |
| | Chip shows | Project | Project · Account · Dot only |
| | Catch an expired login | on | network: `print-access-token` |
| | Login command | `auth login` | args after `gcloud` |
| | Configuration for each space | Automatic | every space on this computer: Automatic or a configuration, then locked until **Unlink**; the chip's menu sets it and makes new ones |

Only in `toolkit.json` (fine as they are for most people): `pr.refreshSeconds` (60), `issues.refreshSeconds` (120), `gcloud.refreshMinutes` (2), `gcloud.tokenCheckMinutes` (10), `context.staleMinutes` (10), `github.accounts` (owner pins).

### The settings file

The file is `~/.config/herdr-app/toolkit.json`. It holds **only what you changed**, so new defaults in later versions still reach you. You can edit it by hand: herdr-toolkit rereads it every ~3 s. If it isn't valid JSON, the last good settings stay and a notification says why.

```json
{
  "tabs": { "agentTitle": false },
  "panels": { "issues": false },
  "context": { "warnAt": 70, "cacheRoots": ["~/.harp"] },
  "gcloud": { "label": "account", "loginArgs": ["auth", "login", "--update-adc"] },
  "agent": { "prefer": "codex" },
  "pr": { "mergeMethod": "squash", "sections": { "files": false } },
  "issues": { "limit": 50 }
}
```

All keys and defaults are in [`toolkit/shared/config.js`](../toolkit/shared/config.js).

### Custom prompts

Replace any agent task's first message with `prompts.<task>`. The tasks are `review`, `describe`, `explain`, `feedback`, `conflicts` and `issue`. Placeholders: `{number}`, `{url}`, `{title}`, `{head}` (branch), `{base}`.

```json
{
  "prompts": {
    "review": "Review {url} ({title}) against CONTRIBUTING.md. Security and data-loss risks first. Findings only, file:line each.",
    "issue": "Read {url} with gh. Propose a plan and wait for my go before changing code."
  }
}
```

---

## 10. Troubleshooting

**Check first.** `herdr-app status` lists errors from layouts and mods; `errors: []` means none. `herdr-app check ~/.config/herdr-app/mods/toolkit-tabs` (or any toolkit mod) loads a mod once and prints what is wrong.

| Symptom | Cause and fix |
|---|---|
| PR or Issues: "The GitHub CLI is not installed." | Install `gh` and run `gh auth login`. |
| PR or Issues: "… can't see owner/repo" | None of your `gh` logins can read that repository. Run `gh auth login` with an account that can, then **Try again**. If one can but wasn't picked, choose it from the panel's gh menu, or pin it in settings → GitHub. |
| PR or Issues: "GitHub could not be read." | The first line of `gh`'s error is shown. Usually auth (`gh auth status`) or a repository whose `origin` isn't on GitHub. |
| "No repository here" | The focused pane isn't inside a git repository. Click into one. |
| "Issues are turned off for this repository." | Issues are disabled on GitHub for that repository. |
| No context % on a Claude tab | No snapshot yet (see [§5](#5-claude-code-context)), or no reading matched (several Claude panes in one folder, and a title that isn't the session name). Check that `claude-statusline.json` updates when that agent works. |
| gcloud chip red right after logging in | Wait ~10 s, or click the chip. Running `gcloud auth print-access-token` in a terminal shows the real error. |
| gcloud chip missing | `gcloud` isn't on Herdr's PATH, or it is turned off in settings. |
| Panel buttons gone | Turned off in settings → Side panels. |
| Settings don't stick | Check that `~/.config/herdr-app/toolkit.json` is valid JSON; a notification says so if it isn't. |
| Something is badly wrong | `ctrl-shift-l` switches layouts. `ctrl-alt-shift-escape` is Herdr's escape hatch: it always goes back to `main`. |

---

## 11. How it is built

```
toolkit/
  layouts/toolkit.json        Herdr's main layout; tabs → toolkit-tabs, footer → toolkit-chrome,
                          panel-body stack holds the five panels
  keys.json               layout:toolkit keys, merged by the installer
  shared/config.js        settings defaults + load/save; copied into each mod
  shared/gh.js gcloud.js  gh logins and gcloud configurations, linked per space
  shell/space-env.zsh     per-space env for new terminals (CLOUDSDK_ACTIVE_CONFIG_NAME)
  mods/
    toolkit-tabs/             tab bar: names, context, gcloud, buttons; publishes toolkit.json
      context.js          status-line snapshot readings
    toolkit-panel/            one mod, six panels chosen by props.panel (+ diff.js, the side-by-side dialog)
      files.js changes.js git.js diff.js pr.js issues.js preview.js lib.js icons/
      gcloud-menu.js      the gcloud chip's menu (a popup)
    toolkit-open-with/        the editor picker
    toolkit-settings/         the settings window
    toolkit-chrome/           Herdr's sidebar header and footer
scripts/
  install.sh              install / --dry-run / --remove
  sync-shared.sh          copies toolkit/shared/*.js into the mods
docs/GUIDE.md             this guide
```

**Design notes**

- **Panels are stack children, not mounted on demand.** `toolkit-tabs` uses `layout.select` / `layout.show` / `layout.hide`, as Herdr's own tab bar does, and never rewrites the layout tree. A hidden panel stays alive, so each panel checks `isShown(id)` before reading git or GitHub.
- **Settings flow.** `toolkit-tabs` (always on screen) reads `toolkit.json` every 3 s and publishes it as shared `toolkit.settings`. Every mod reads `cfg()` (defaults with the file laid over them) and re-renders when it changes. `toolkit-settings` writes the file, as a diff from the defaults, and publishes at once.
- **Shared code.** Herdr mods can't import each other's files, so `toolkit/shared/config.js` is copied into each mod by `scripts/sync-shared.sh`. Edit only the shared copy, then run the script (`install.sh` runs it too).
- **No spinners.** Working states use slow `.loop("opacity")` dots. A `.spin()` redraws the whole window constantly.

**Developing**

```sh
scripts/sync-shared.sh
for m in toolkit/mods/*; do herdr-app check "$PWD/$m"; done
scripts/install.sh                      # Herdr hot-reloads the mods
herdr-app status                        # errors: []
herdr-app shot /tmp/toolkit.png             # last rendered frame (bring Herdr to front first)
```

Read `~/.config/herdr-app/AGENTS.md` and the `.d.ts` files next to it for Herdr's mod API; they match your installed version.
