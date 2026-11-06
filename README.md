# herdr-serhii

A personal fork of [herdr-sab](https://github.com/thabti/herdr-sab). Upstream is the `upstream` git remote;
it installs as the `serhii` layout with `serhii-*` mods, so it can sit next to herdr-sab.

A slim layout for the [Herdr](https://herdr.dev) desktop app. It keeps Herdr's own
window (spaces and agents on the left, tabs, panes as cards, status bar) and adds
only what you need to review and ship agent work without leaving it.

It borrows the best parts of [Kanso](https://github.com/jlopezlira/herdr-kanso)
and [Mission Control](https://github.com/CiprianSpiridon/herdr-mission-control),
without their whole layouts: no pane strip, no new sidebar, no tracker setup.

**→ [The guide](docs/GUIDE.md)** covers every feature, the settings, workflows and troubleshooting.

## Quick install

1. Have the [Herdr desktop app](https://herdr.dev) open, plus `git` and `python3`. For the PR and
   Issues panels, install the [GitHub CLI](https://cli.github.com) and run `gh auth login`.
2. Clone and install:

   ```sh
   git clone <your-fork-url> herdr-serhii
   cd herdr-serhii
   scripts/install.sh
   ```

3. Switch to the layout:

   ```sh
   herdr-app do layout.switch --name serhii
   ```

4. Open **herdr-serhii settings** (`⌘⌥,`) to turn features on or off.

`ctrl-shift-l` takes you back to your previous layout. More options are under [Install](#install).

## What you get

- **A right side panel** with **Files**, **Changes**, **Git**, **Pull requests** and **Issues**. It follows the pane you're in, so each session sees its own repository.
  - **PR**: every open pull request, with labels, comments, checks, unresolved threads, reviewers, files and diffs, and merge. One click hands your agent a **Code review**, **Describe change**, **Explain**, **Address feedback** or **Resolve conflicts** task in a new tab.
  - **Issues** (off by default): the repository's open GitHub issues, grouped and filterable. Click one to open it in the browser, or **Start** to put your agent on it.
  - **Git**: the repository's worktrees, its branches (the checked-out one marked, ↑↓ against upstream) and the commit graph with branch labels.
  - **Changes**: click a file to compare it side by side (HEAD | working tree), as in an IDE.
  - **Changes** in a folder of repositories (not one itself) shows each repository in its own section, with a filter chip per repository, and commits to the one you pick. **Create PR** beside Commit pushes the branch and opens a draft pull request from its commits.
  - **Several `gh` accounts?** Each repository is read with the logged-in account that can see it, found automatically. The account menu in the panel header switches it per repository or adds one.
- **Tabs that name themselves.** An unnamed tab shows the Jira key its branch carries (`DS-1234`) or its agent's own title. A name you type always wins.
- **Jira everywhere.** Set your site and every key like `DS-1234` links to its ticket: on tabs (`⌘⌥J`), pull request titles, branches, descriptions and comments, issues, and Markdown previews.
- **Claude Code context %** on each Claude tab, from its status line. An idle agent keeps its last reading, dimmed, with its age in the tooltip.
- **gcloud login at a glance.** A chip shows whether you're logged in and to which project. A small button runs `gcloud auth login`.
- **Your editor, one key away.** A Finder button opens the focused pane's folder in Finder. `⌘⇧O` or the **Editor** button opens the pane's folder, or a file from Files, in Cursor, VS Code, Zed, Windsurf, Sublime, a JetBrains IDE, Xcode, or Neovim, Helix or Vim in a split.
- **Settings for all of it.** **herdr-serhii settings** opens from the ⚙ in the tab bar (or `⌘⌥,`). Every feature can be turned off or tuned there. Changes apply live and are saved to `~/.config/herdr-app/serhii.json`.

## Install

You need the Herdr desktop app, `git`, `python3`, and the [GitHub CLI](https://cli.github.com) (`gh auth login`) for the PR and Issues panels. `gcloud` is optional.

`scripts/install.sh --dry-run` shows what the installer will copy and changes nothing. A real run
copies the layout and 5 mods into `~/.config/herdr-app`, adds 4 keys, and runs `herdr-app check` on
each mod. It never overwrites files it didn't install, and it leaves keys you already use alone.
`HERDR_APP_HOME=/path scripts/install.sh` installs into another Herdr home.

- **Update:** `git pull && scripts/install.sh`. Herdr reloads the mods live.
- **Switch back:** `ctrl-shift-l` returns to your previous layout.
- **Remove:** `scripts/install.sh --remove` deletes everything the installer added. Your settings
  in `~/.config/herdr-app/serhii.json` stay.

## Keys

| Keys | What they do |
|---|---|
| `⌘⇧O` | Open the focused pane's folder in an editor |
| `⌘⌥,` | herdr-serhii settings |
| `⌘⌥G` | `gcloud auth login` in a new tab |
| `⌘⌥J` | Open the tab's Jira ticket |
| Double-click a tab, or `F2` | Name it (empty: back to the automatic name) |

## What it runs

`git` and `find` (Files, Changes), `gh` (PR and Issues, only while that panel is shown), `gcloud`
(`config list`, `auth list`, and `auth print-access-token` for the login check), and `open`/`sh` to
find and start editors. It reads files only in the folders you work in, plus your Claude Code
status-line snapshot. The PR panel can change GitHub when you click: merge (it asks twice), close,
draft, labels, assignees and reviewers.

## Credits and license

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The panels and Open with
are derived from Kanso by jlopezlira (Apache-2.0), which grew from the mods shipped with Herdr.
The tab bar and sidebar footer start from Herdr's shipped `tabs` and `workspace-chrome`.
Self-naming tabs and Claude context readings are ideas from Mission Control. Each derived
file's header says what changed.
