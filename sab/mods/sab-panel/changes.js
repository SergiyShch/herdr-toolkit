// Derived from the `changes` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: root no longer draws its own rounded, bordered card.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-changes.
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-changes; one of the kanso-panel mod's panels.
// Modified for herdr-sab: one of the sab-panel mod's panels; reads only while shown.
// A folder that is not a repository but holds several (~/work/client/api,
// ~/work/client/web…) shows each one's changes in its own section, with a
// filter per repository, and commits to one repository at a time.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, settings, home, notify } from "herdr";
import { location, key, diffRows, insideRoot, isShown, cfg, createPr, defaultBranch, showPanel, openUrl } from "./lib.js";

const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
// Lines added and removed, read live: an untracked file's count fills in once its diff loads.
const total = (files, k) => files.reduce((n, f) => n + f[k], 0);
const MAX_FILES = 1000, ROW = 28, MAX_WATCH = 20, RESCAN_MS = 30000;
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
  const max = Math.max(1, Math.min(100, Number(cfg().changes.maxRepos) || 40));
  return found.filter((p, i) => !found.slice(0, i).some((q) => p.startsWith(q + "/"))).slice(0, max);
}

// One repository's uncommitted changes.
async function readRepo(root, name, on) {
  const git = (args) => exec("git", args, { cwd: root, on });
  const [status, head, branch] = await Promise.all([
    git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
    git(["rev-parse", "--verify", "HEAD"]),
    git(["branch", "--show-current"]).catch(() => null),
  ]);
  if (status.code !== 0) throw new Error((status.stderr || "git status failed").trim());
  const hasHead = head.code === 0, stats = {};
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
  // Commits on this branch that its base (origin's default branch) doesn't have: what a pull request would hold.
  const name0 = branch?.code === 0 ? branch.stdout.trim() : "";
  const base = hasHead && name0 ? await defaultBranch(root, on) : null;
  const ahead = base && name0 !== base ? Number((await git(["rev-list", "--count", `refs/remotes/origin/${base}..HEAD`]).catch(() => null))?.stdout.trim()) || 0 : 0;
  const files = [], entries = status.stdout.split("\0").filter(Boolean);
  for (const entry of entries.slice(0, MAX_FILES)) {
    const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    files.push({ path, status: s, fresh, stagedDeletion: xy === "D ", ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  return { root, name, on, hasHead, files, limited: entries.length > MAX_FILES, branch: name0, base, ahead };
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
    this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => { this.message = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
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
            if (this.watching === set && this.context === context) this.later(cx);
          }
        } catch { set.delete(root); }
      });
    }
  }

  // A save storm wakes the watch once per file. Fold that into one refresh.
  later(cx) {
    this.queued = true;
    if (this.armed) return;
    this.armed = cx.timer.after(400, (cx) => {
      this.armed = null;
      if (!this.queued) return;
      if (this.loading || this.busy) { this.later(cx); return; }
      this.queued = false;
      this.refresh(cx);
    });
  }

  reset() {
    this.repos = []; this.multi = false; this.filter = null; this.collapsed = new Set(); this.scan = null; this.open = null; this.closed = false;
    this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.clean = 0; this.prUrl = null;
    this.watching = new Set();
  }

  refresh(cx) {
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
          repos = await pool(this.scan.names, 6, (name) => readRepo(`${cwd}/${name}`, name, on)
            .catch((e) => ({ root: `${cwd}/${name}`, name, on, files: [], branch: "", error: String(e?.message ?? e) })));
        }
        if (key() !== context) return;
        this.repos = repos; this.multi = multi; this.on = on; this.error = null;
        this.clean = repos.filter((r) => !r.files.length && !r.error).length;
        if (this.filter && !repos.some((r) => r.root === this.filter)) this.filter = null;
        this.watch(repos.map((r) => r.root), cx);
        const repo = this.open && repos.find((r) => r.root === this.open.root);
        if (this.open && !repo?.files.some((f) => f.path === this.open.path)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed) {
          const first = this.shown().find((r) => r.files.length && !this.collapsed.has(r.root));
          if (first) this.open = { root: first.root, path: first.files[0].path };
        }
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  clear(error) {
    this.repos = []; this.multi = false; this.open = null; this.setLines([]); this.error = error; this.clean = 0;
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

  async load({ root, path }, context) {
    const repo = this.repos.find((r) => r.root === root), file = repo?.files.find((f) => f.path === path);
    if (!file) return;
    const on = repo.on;
    let lines;
    if (!insideRoot(path)) lines = ["Cannot preview this file"];
    else if (file.fresh || (!repo.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", ["diff", ...(repo.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open?.root === root && this.open?.path === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  isOpen(root, path) { return this.open?.root === root && this.open?.path === path; }

  pick(root, path, cx) {
    this.open = this.isOpen(root, path) ? null : { root, path }; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context, open = this.open;
    if (open) cx.spawn(async (cx) => {
      try { await this.load(open, context); }
      catch (e) { if (key() === context && this.isOpen(root, path)) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  setFilter(root, cx) {
    this.filter = root; this.note = null;
    if (root && this.open && this.open.root !== root) { this.open = null; this.closed = false; this.setLines([]); }
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

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  fileRow(repo, f, t) {
    const parts = f.path.split("/"), name = parts.pop(), indent = this.multi ? 18 : 0;
    return h_flex().id(`change-${repo.name}/${f.path}`).h(ROW).flex_none().pl(8 + indent).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(this.isOpen(repo.root, f.path), (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(repo.root, f.path, cx))
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
      .child(svg(`mods/sab-panel/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(svg("mods/sab-panel/folder.svg").size(14).flex_none().text_color(target ? t.accent : t.muted))
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
      .child(v_flex().id("changes-list").flex_none().h(Math.min(this.multi ? 280 : 200, Math.max(44, items.length * ROW + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
        .children(items.map((it) => it.f ? this.fileRow(it.repo, it.f, t) : this.repoRow(it.repo, t)))
        .when(!files.length && !(this.multi && items.length), (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
      .when(limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files of a repository")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
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
