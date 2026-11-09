// Derived from the `changes` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: root no longer draws its own rounded, bordered card.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-changes.
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-changes; one of the kanso-panel mod's panels.
// Modified for herdr-toolkit: one of the toolkit-panel mod's panels; reads only while shown; a click opens the file side by side (no diff in the panel); counts new files' lines.
// A folder that is not a repository but holds several (~/work/client/api,
// ~/work/client/web…) shows each one's changes in its own section, with a
// filter per repository, and commits to one repository at a time.
// A file opens side by side (HEAD | working tree) in a dialog (diff.js);
// the panel itself is only the list, with no diff under it.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, watchFolder, theme, home, notify, openOverlay } from "herdr";
import { location, key, insideRoot, isShown, cfg, createPr, defaultBranch, showPanel, openUrl } from "./lib.js";

// Lines added and removed, read live: an untracked file's count fills in once its diff loads.
const total = (files, k) => files.reduce((n, f) => n + f[k], 0);
const MAX_FILES = 1000, ROW = 28, MAX_WATCH = 20, RESCAN_MS = 30000, FULL_MS = 30000;
// Folders not worth looking into for repositories (build output, packages).
const SKIP = ["node_modules", "vendor", "target", "dist", "build", "Pods", "DerivedData", "__pycache__"];

// The repositories under `cwd` (which is not one), as paths relative to it,
// sorted. Hidden folders and SKIP are not entered, nor a repository found
// (its own nested repositories show as its untracked folders).
async function findRepos(cwd, on) {
  const depth = Math.max(1, Math.min(5, Number(cfg().changes.scanDepth) || 2));
  const prune = SKIP.flatMap((name, i) => [...(i ? ["-o"] : []), "-name", name]);
  const r = await exec("find", ["-H", ".", "-mindepth", "1", "-maxdepth", String(depth + 1),
    "(", "-name", ".git", "-print0", "-prune", ")", "-o",
    "(", ...prune, "-o", "-name", ".*", ")", "-prune"], { cwd, on }).catch(() => null);
  if (!r || (r.code !== 0 && !r.stdout)) return [];
  const found = r.stdout.split("\0").filter((p) => p.startsWith("./") && p.endsWith("/.git"))
    .map((p) => p.slice(2, -5)).filter((p) => p && insideRoot(p)).sort();
  const max = Math.max(1, Math.min(200, Number(cfg().changes.maxRepos) || 100));
  return found.filter((p, i) => !found.slice(0, i).some((q) => p.startsWith(q + "/"))).slice(0, max);
}

// What rarely changes, so a refresh needn't ask again: each repository's base
// (origin's default branch, for 5 min) and how far HEAD is ahead of it (until
// HEAD or the base moves). Every git call costs ~80 ms through macOS's
// /usr/bin/git shim, and a folder can hold dozens of repositories.
const BASES = new Map(), AHEAD = new Map(), BASE_MS = 5 * 60000;

async function baseOf(root, on) {
  const k = `${on ?? ""}|${root}`, hit = BASES.get(k);
  if (hit && Date.now() - hit.at < BASE_MS) return hit.base;
  const base = await defaultBranch(root, on).catch(() => null);
  BASES.set(k, { base, at: Date.now() });
  return base;
}

async function aheadOf(root, on, oid, base) {
  const k = `${on ?? ""}|${root}|${oid}|${base}`;
  if (AHEAD.has(k)) return AHEAD.get(k);
  // The base's own tip, so a fetch that moves it counts again.
  const r = await exec("git", ["rev-list", "--count", `refs/remotes/origin/${base}..HEAD`], { cwd: root, on }).catch(() => null);
  const n = r?.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  if (AHEAD.size > 500) AHEAD.clear();
  AHEAD.set(k, n);
  return n;
}

// One repository's uncommitted changes. A clean one costs a single git call:
// porcelain v2 with --branch also says the branch and whether HEAD exists.
async function readRepo(root, name, on) {
  const git = (args) => exec("git", args, { cwd: root, on });
  const status = await git(["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error((status.stderr || "git status failed").trim());
  let oid = null, branch = "";
  const entries = [];
  for (const entry of status.stdout.split("\0")) {
    if (!entry) continue;
    if (entry.startsWith("# branch.oid ")) { const v = entry.slice(13); oid = v === "(initial)" ? null : v; continue; }
    if (entry.startsWith("# branch.head ")) { const v = entry.slice(14); branch = v === "(detached)" ? "" : v; continue; }
    if (entry[0] === "#" || entry[0] === "!") continue;
    // "1 XY sub mH mI mW hH hI path", "u XY sub m1 m2 m3 mW h1 h2 h3 path", "? path".
    if (entry[0] === "?") { entries.push({ xy: "??", path: entry.slice(2) }); continue; }
    const skip = entry[0] === "u" ? 10 : entry[0] === "1" ? 8 : -1;
    if (skip < 0) continue;
    const parts = entry.split(" ");
    entries.push({ xy: parts[1].replace(/\./g, " "), path: parts.slice(skip).join(" ") });
  }
  const hasHead = Boolean(oid), stats = {};
  if (entries.length) {
    const results = hasHead ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
    for (const result of results) {
      if (result.code !== 0) throw new Error(result.stderr);
      for (const entry of result.stdout.split("\0")) {
        const [a, d, ...parts] = entry.split("\t");
        if (!parts.length) continue;
        const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
        stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
      }
    }
  }
  // Commits on this branch that its base (origin's default branch) doesn't have: what a pull request would hold.
  const base = hasHead && branch ? await baseOf(root, on) : null;
  const ahead = base && branch !== base ? await aheadOf(root, on, oid, base) : 0;
  // A new (untracked) file has no diff to count: its lines are its additions.
  // One `wc -l` for all of them (up to MAX_COUNT).
  const fresh = entries.slice(0, MAX_FILES).filter((e) => e.xy === "??" && insideRoot(e.path) && !stats[e.path]).map((e) => e.path);
  if (fresh.length) Object.assign(stats, await countNew(root, on, fresh.slice(0, MAX_COUNT)));
  const files = [];
  for (const { xy, path } of entries.slice(0, MAX_FILES)) {
    const fresh = xy === "??", conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    files.push({ path, status: s, fresh, stagedDeletion: xy === "D ", ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  return { root, name, on, hasHead, files, limited: entries.length > MAX_FILES, branch, base, ahead };
}

// Lines in new files, as { path: { add, del: 0 } }: one `wc -l` call. A file
// whose last line has no newline counts one short, as `wc` does.
const MAX_COUNT = 200;
async function countNew(root, on, paths) {
  const r = await exec("wc", ["-l", "--", ...paths], { cwd: root, on }).catch(() => null);
  const out = {};
  for (const line of (r?.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m && paths.includes(m[2])) out[m[2]] = { add: Number(m[1]), del: 0 };
  }
  return out;
}

// Runs `fn` over `items`, `n` at a time, in order.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Lives in the panel stack while hidden: refresh() waits until it is shown.
export class Changes {
  init(cx) {
    this.repos = []; this.multi = false; this.filter = null; this.collapsed = new Set(); this.watching = new Set();
    this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => { this.message = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => { if (!this.multi || Date.now() - (this.fullAt ?? 0) >= FULL_MS) this.refresh(cx); });
  }

  // One watch per repository on this computer (remote folders refresh on the timer).
  watch(roots, cx) {
    if (this.on) return;
    const context = this.context, set = this.watching;
    for (const root of roots.slice(0, MAX_WATCH)) {
      if (set.has(root)) continue;
      set.add(root);
      cx.spawn(async (cx) => {
        try {
          while (this.watching === set && set.has(root) && this.context === context) {
            await watchFolder(root);
            if (this.watching === set && this.context === context) this.later(cx, root);
          }
        } catch { set.delete(root); }
      });
    }
  }

  // A save storm wakes the watch once per file. Fold that into one refresh,
  // of only the repositories that changed when it came from their watches.
  later(cx, root) {
    if (root) (this.touched ??= new Set()).add(root); else this.queued = true;
    if (this.armed) return;
    this.armed = cx.timer.after(400, (cx) => {
      this.armed = null;
      if (!this.queued && !this.touched?.size) return;
      if (this.loading || this.busy) { this.later(cx); return; }
      const only = this.queued || !this.multi ? null : [...this.touched];
      this.queued = false; this.touched = null;
      this.refresh(cx, only);
    });
  }

  reset() {
    this.repos = []; this.multi = false; this.filter = null; this.collapsed = new Set(); this.scan = null; this.open = null;
    this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.clean = 0; this.prUrl = null;
    this.watching = new Set(); this.fullAt = 0; this.touched = null;
  }

  // `only`: roots to read again (from their watches); the rest keep what they had.
  refresh(cx, only = null) {
    if (!isShown(this.id)) { this.stale = true; return; }
    this.stale = false;
    if (this.loading || this.busy) { this.later(cx); return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        let repos, multi = false;
        if (top.code === 0) {
          const root = top.stdout.trim();
          repos = [await readRepo(root, root.split(/[\\/]/).pop(), on)];
        } else {
          // Not a repository: the repositories inside it, found again every 30 s.
          if (!cfg().changes.nested || cwd === "/" || (!on && cwd === home())) { this.clear("Not a git repository"); return; }
          if (!this.scan || Date.now() - this.scan.at > RESCAN_MS) this.scan = { at: Date.now(), names: await findRepos(cwd, on) };
          if (key() !== context) return;
          if (!this.scan.names.length) { this.clear("Not a git repository, and none in the folders below"); return; }
          multi = true;
          const had = new Map(this.multi ? this.repos.map((r) => [r.root, r]) : []), full = !only;
          repos = await pool(this.scan.names, 8, (name) => {
            const root = `${cwd}/${name}`;
            if (!full && had.has(root) && !only.includes(root)) return had.get(root);
            return readRepo(root, name, on).catch((e) => ({ root, name, on, files: [], branch: "", error: String(e?.message ?? e) }));
          });
          if (full) this.fullAt = Date.now();
        }
        if (key() !== context) return;
        this.repos = repos; this.multi = multi; this.on = on; this.error = null;
        this.clean = repos.filter((r) => !r.files.length && !r.error).length;
        if (this.filter && !repos.some((r) => r.root === this.filter)) this.filter = null;
        this.watch(repos.map((r) => r.root), cx);
        const repo = this.open && repos.find((r) => r.root === this.open.root);
        if (this.open && !repo?.files.some((f) => f.path === this.open.path)) this.open = null;
      } catch (e) { if (key() === context) this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  clear(error) {
    this.repos = []; this.multi = false; this.open = null; this.error = error; this.clean = 0;
  }

  // The repositories the list shows: the one picked, else every one with changes.
  shown() {
    if (!this.multi) return this.repos;
    if (this.filter) return this.repos.filter((r) => r.root === this.filter);
    return this.repos.filter((r) => r.files.length || r.error || r.ahead);
  }

  // Where Commit goes: the only repository, the one picked, or the one whose diff is open.
  target() {
    if (!this.multi) return this.repos[0] ?? null;
    const root = this.filter ?? this.open?.root;
    if (root) return this.repos.find((r) => r.root === root) ?? null;
    const changed = this.repos.filter((r) => r.files.length || r.ahead);
    return changed.length === 1 ? changed[0] : null;
  }

  // The file's last commit and working tree side by side, in a dialog (diff.js),
  // with the list's other files so its arrows walk on to them.
  sideBySide(repo, f) {
    const one = (r, x) => ({ root: r.root, path: x.path, on: r.on ?? null, fresh: x.fresh, hasHead: r.hasHead, status: x.status });
    const files = this.shown().flatMap((r) => r.files.filter((x) => insideRoot(x.path)).map((x) => one(r, x))).slice(0, 2000);
    openOverlay({ mod: "toolkit-panel", kind: "dialog", width: 0.94, height: 0.9, props: { panel: "diff", ...one(repo, f), files } });
  }

  isOpen(root, path) { return this.open?.root === root && this.open?.path === path; }

  // Picks the file (Commit and Create PR follow its repository) and opens it side by side.
  pick(repo, f, cx) {
    this.open = { root: repo.root, path: f.path }; this.note = null;
    if (!insideRoot(f.path)) this.note = "Cannot show this file";
    else this.sideBySide(repo, f);
    cx.notify();
  }

  setFilter(root, cx) {
    this.filter = root; this.note = null;
    if (root && this.open && this.open.root !== root) this.open = null;
    if (root) this.collapsed.delete(root);
    this.refresh(cx);
    cx.notify();
  }

  toggleRepo(root, cx) {
    if (this.collapsed.has(root)) this.collapsed.delete(root); else this.collapsed.add(root);
    cx.notify();
  }

  commit(cx) {
    const repo = this.target();
    if (!cfg().changes.commit || !this.message.trim() || !repo || this.busy || this.loading || this.context !== key()) return;
    const { root, on, limited } = repo, context = this.context, message = this.message.trim();
    const files = repo.files.filter((f) => insideRoot(f.path));
    const paths = files.filter((f) => !f.stagedDeletion).map((f) => f.path);
    if (!files.length) { this.note = `Nothing to commit in ${repo.name}`; cx.notify(); return; }
    this.busy = true; this.note = null; this.prUrl = null;
    cx.spawn(async (cx) => {
      try {
        // Only the files listed here. `git add -A` would also stage everything
        // else in the worktree, including secrets that were never shown.
        // A staged deletion is already absent from both disk and the index;
        // adding it by path would fail. It still belongs in the commit.
        const commands = paths.length ? [["--literal-pathspecs", "add", "-A", "--", ...paths]] : [];
        commands.push(["commit", "-m", message]);
        for (const args of commands) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) {
          this.message = "";
          this.input.set_value("");
          if (limited) this.note = `Committed the 1,000 files listed in ${repo.name}.`;
          else if (this.multi) this.note = null;
        }
      } catch (e) { if (key() === context) this.note = `Commit failed in ${repo.name}: ${e?.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Can the repository Commit goes to open a pull request: a branch that isn't its base, with commits the base doesn't have.
  canCreatePr(repo) {
    return Boolean(cfg().changes.createPr !== false && repo?.branch && repo.base && repo.branch !== repo.base && repo.ahead > 0);
  }

  // Pushes the target's branch and opens a pull request for it (lib.js createPr).
  createPr(cx) {
    const repo = this.target();
    if (!this.canCreatePr(repo) || this.busy || this.loading || this.context !== key()) return;
    const context = this.context, multi = this.multi;
    this.busy = "pr"; this.note = null; this.prUrl = null;
    cx.spawn(async (cx) => {
      try {
        const { url, existed } = await createPr(repo.root, repo.on);
        if (key() !== context) return;
        this.prUrl = url;
        this.note = existed ? `${repo.name} already has a pull request: ${url}` : `Pull request created for ${repo.name}: ${url ?? "see the PR panel"}`;
        if (!existed) notify({ title: `Pull request created · ${repo.name}`, body: url ?? repo.branch, level: "success" });
        // The PR panel follows the pane's repository; in a folder of repositories it has none to show.
        if (!multi) showPanel("pr");
      } catch (e) { if (key() === context) this.note = `Could not create the pull request in ${repo.name}: ${e?.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  fileRow(repo, f, t) {
    const parts = f.path.split("/"), name = parts.pop(), indent = this.multi ? 18 : 0;
    return h_flex().id(`change-${repo.name}/${f.path}`).h(ROW).flex_none().pl(8 + indent).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(this.isOpen(repo.root, f.path), (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip("Compare side by side").on_click((_e, cx) => this.pick(repo, f, cx))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // A repository's section header: click to fold it.
  repoRow(repo, t) {
    const folded = this.collapsed.has(repo.root), target = this.target()?.root === repo.root;
    const add = total(repo.files, "add"), del = total(repo.files, "del");
    return h_flex().id(`change-repo-${repo.name}`).h(ROW).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(repo.error ? `${repo.root}\n${repo.error}` : repo.root).on_click((_e, cx) => this.toggleRepo(repo.root, cx))
      .child(svg(`mods/toolkit-panel/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(svg("mods/toolkit-panel/folder.svg").size(14).flex_none().text_color(target ? t.accent : t.muted))
      .child(div().min_w(0).truncate().font_semibold().child(repo.name))
      .when(Boolean(repo.branch), (e) => e.child(div().min_w(0).flex_shrink(1).truncate().text_size(11).text_color(t.dim).child(repo.branch)))
      .child(div().flex_1())
      .when(Boolean(repo.error), (e) => e.child(div().text_size(11).text_color(t.ansi1).child("error")))
      .when(repo.ahead > 0, (e) => e.child(div().id(`change-ahead-${repo.name}`).text_size(11).text_color(t.accent).tooltip(`${repo.ahead} commit${repo.ahead === 1 ? "" : "s"} not on ${repo.base}`).child(`↑${repo.ahead}`)))
      .when(!repo.error, (e) => e.child(div().text_size(11).text_color(t.dim).child(repo.files.length ? `${repo.files.length}` : "clean")))
      .when(add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)));
  }

  // All · api 3 · web 5: which repository the list (and Commit) is about.
  filterChips(t) {
    const changed = this.repos.filter((r) => r.files.length || r.error || r.ahead || r.root === this.filter);
    const chip = (id, label, count, on, onClick) => h_flex().id(id).h(22).px(8).gap(5).flex_none().items_center().rounded(11).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx))
      .child(div().max_w(140).truncate().text_size(11.5).text_color(on ? t.foreground : t.muted).child(label))
      .when(count !== null, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
    return div().id("changes-repos").flex_none().max_h(66).overflow_y_scrollbar().border_b(1).border_color(t.border)
      .child(h_flex().flex_wrap().gap(6).px(10).py(6)
        .child(chip("changes-repo-all", "All", changed.reduce((n, r) => n + r.files.length, 0), !this.filter, (cx) => this.setFilter(null, cx)))
        .children(changed.map((r, i) => chip(`changes-repo-f${i}`, r.name, r.error ? "!" : r.files.length, this.filter === r.root, (cx) => this.setFilter(this.filter === r.root ? null : r.root, cx)))));
  }

  render(cx) {
    if (isShown(this.id) && (this.stale || key() !== this.context)) this.refresh(cx);
    const t = theme(), shown = this.shown(), target = this.target();
    const files = shown.flatMap((r) => r.files), add = total(files, "add"), del = total(files, "del");
    const items = [];
    for (const repo of shown) {
      if (this.multi) items.push({ repo });
      if (!this.multi || !this.collapsed.has(repo.root)) for (const f of repo.files) items.push({ repo, f });
    }
    const enabled = Boolean(this.message.trim() && target?.files.length && !this.busy && !this.loading);
    const empty = this.error || (this.loading && !this.repos.length ? "Loading changes…"
      : this.multi ? (this.filter ? "No uncommitted changes in this repository" : `No uncommitted changes in ${this.repos.length} repositories`)
      : this.repos.length ? "No uncommitted changes" : "No folder");
    const limited = shown.some((r) => r.limited);
    const commitOn = cfg().changes.commit, pr = this.canCreatePr(target), prReady = pr && !this.busy && !this.loading;
    return v_flex().id("changes").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(6).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${files.length} files`))
        .when(this.multi, (e) => e.child(div().id("changes-repo-count").text_size(11).text_color(t.dim)
          .tooltip(this.clean ? `${this.clean} of them without changes` : "Every one has changes").child(`${this.repos.length} repos`)))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .when(this.multi, (e) => e.child(this.filterChips(t)))
      .child(v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(items.map((it) => it.f ? this.fileRow(it.repo, it.f, t) : this.repoRow(it.repo, t)))
        .when(!files.length && !(this.multi && items.length), (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
      .when(limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files of a repository")))
      .when(Boolean(this.note), (e) => e.child(div().id("changes-note").px(10).py(6).text_size(11).text_color(this.prUrl ? t.ansi2 : t.ansi1)
        .when(Boolean(this.prUrl), (e) => e.cursor_pointer().tooltip("Open in the browser").on_click(() => openUrl(this.prUrl)))
        .child(this.note)))
      .when(commitOn || pr, (e) => e.child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .when(this.multi, (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(!target ? "Pick a repository above, or a file, to commit"
          : `${target.files.length ? `Commits ${target.files.length} file${target.files.length === 1 ? "" : "s"} to` : "Branch of"} ${target.name}${target.branch ? ` · ${target.branch}` : ""}${target.ahead ? ` · ↑${target.ahead}` : ""}`)))
        .child(h_flex().gap(8)
          .when(commitOn, (e) => e
            .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
            .child(div().id("commit").h(32).px(14).flex().items_center().rounded(6).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy === true ? "Committing…" : "Commit")))
          .when(!commitOn, (e) => e.child(div().flex_1()))
          .when(pr, (e) => e.child(div().id("create-pr").h(32).px(12).flex().items_center().rounded(6).border_1().border_color(t.border)
            .text_size(12).text_color(prReady ? t.foreground : t.dim).when(prReady, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
            .tooltip(`Push ${target.branch} and open a ${cfg().pr.createDraft === false ? "" : "draft "}pull request into ${target.base}, titled from its ${target.ahead} commit${target.ahead === 1 ? "" : "s"}`)
            .on_click((_e, cx) => this.createPr(cx)).child(this.busy === "pr" ? "Creating…" : "Create PR"))))));
  }
}
