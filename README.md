# herdr-sab

A slim layout for the [Herdr](https://herdr.dev) desktop app. It keeps Herdr's own
window (spaces and agents on the left, tabs, panes as cards, status bar) and adds
only what you need to review and ship agent work without leaving it.

It borrows the best parts of [Kanso](https://github.com/jlopezlira/herdr-kanso)
and [Mission Control](https://github.com/CiprianSpiridon/herdr-mission-control),
without their whole layouts: no pane strip, no new sidebar, no tracker setup.

**→ [The guide](docs/GUIDE.md)** covers every feature, the settings, workflows and troubleshooting.

## What you get

- **A right side panel** with **Files**, **Changes**, **Pull requests** and **Issues**. It follows the pane you're in, so each session sees its own repository.
  - **PR**: every open pull request, with checks, unresolved threads, reviewers, labels, files and diffs, and merge. One click hands your agent a **Code review**, **Describe change**, **Explain**, **Address feedback** or **Resolve conflicts** task in a new tab.
  - **Issues**: the repository's open GitHub issues, grouped and filterable. Click one to open it in the browser, or **Start** to put your agent on it.
- **Tabs that name themselves.** An unnamed tab shows the issue key its branch carries (`WEB-142`, `#123`) or its agent's own title. A name you type always wins.
- **Claude Code context %** on each Claude tab, from its status line. An idle agent keeps its last reading, dimmed, with its age in the tooltip.
- **gcloud login at a glance.** A chip shows whether you're logged in and to which project. A small button runs `gcloud auth login`.
- **Your editor, one key away.** `⌘⇧O` or the tab bar button opens the pane's folder, or a file from Files, in Cursor, VS Code, Zed, Windsurf, Sublime, a JetBrains IDE, Xcode, or Neovim, Helix or Vim in a split.
- **Settings for all of it.** **herdr-sab settings** sits under Herdr's own **Settings** in the sidebar. Every feature can be turned off or tuned there. Changes apply live and are saved to `~/.config/herdr-app/sab.json`.

## Install

You need the Herdr desktop app, `git`, `python3`, and the [GitHub CLI](https://cli.github.com) (`gh auth login`) for the PR and Issues panels. `gcloud` is optional.

```sh
git clone https://github.com/thabti/herdr-sab
cd herdr-sab
scripts/install.sh --dry-run     # shows what it will copy; changes nothing
scripts/install.sh               # copies the layout and 5 mods, adds 3 keys, runs herdr-app check
herdr-app do layout.switch --name sab
```

`ctrl-shift-l` switches back to your previous layout. `scripts/install.sh --remove`
removes everything the installer added. It never overwrites files it didn't install,
and it leaves keys you already use alone.

## Keys

| Keys | What they do |
|---|---|
| `⌘⇧O` | Open the focused pane's folder in an editor |
| `⌘⌥,` | herdr-sab settings |
| `⌘⌥G` | `gcloud auth login` in a new tab |
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
