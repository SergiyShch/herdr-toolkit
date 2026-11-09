// The repository's shape at a glance: its worktrees (the pane's one marked),
// its local branches (the checked-out one first, with ↑ahead ↓behind its
// upstream) and the commit graph (`git log --graph`) with branch and tag
// labels, each on its own tab (Graph · Branches · Worktrees). Click a branch
// to find its tip in the graph; click another
// worktree to open a tab there; click a commit to list its files, and a
// file to compare it with the commit's parent side by side (diff.js).
// Reads git only; it never checks anything out.
// New for herdr-toolkit.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, watchFolder, theme, settings, home, run, spaces, shared, setShared, openOverlay } from "herdr";
import { location, key, isShown, cfg, insideRoot, defaultBranch, ICON } from "./lib.js";

const ROW = 22, LIST = 26, SCOPE = "toolkit.gitScope", TAB = "toolkit.gitTab";
// Graph columns take the terminal's hues in turn.
const LANES = ["ansi4", "ansi2", "ansi5", "ansi3", "ansi6", "ansi1"];

// `git log --graph` lines → { graph, sha, refs, subject, when, author } (a
// line with no commit only carries graph, the lines between commits).
export function parseGraph(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf("\x01");
    if (at < 0) return { graph: line.replace(/\s+$/, "") };
    const [sha, full, refs, subject, when, author] = line.slice(at + 1).split("\x00");
    return { graph: line.slice(0, at).replace(/\s+$/, ""), sha, full, refs: parseRefs(refs ?? ""), subject: subject ?? "", when: when ?? "", author: author ?? "" };
  });
}

// "%D": "HEAD -> main, origin/main, tag: v1" → [{ name, kind }]
export function parseRefs(text) {
  const out = [];
  for (const part of text.split(", ").map((s) => s.trim()).filter(Boolean)) {
    if (part.startsWith("HEAD -> ")) { out.push({ name: part.slice(8), kind: "head" }); continue; }
    if (part === "HEAD") { out.push({ name: "HEAD", kind: "head" }); continue; }
    if (part.startsWith("tag: ")) { out.push({ name: part.slice(5), kind: "tag" }); continue; }
    if (part.endsWith("/HEAD")) continue;
    out.push({ name: part, kind: isRemote(part) ? "remote" : "local" });
  }
  return out;
}
let REMOTES = ["origin"];
const isRemote = (name) => REMOTES.some((r) => name.startsWith(r + "/"));

// `git worktree list --porcelain` → [{ path, head, branch, detached, bare }]
export function parseWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9), head: "", branch: "", detached: false, bare: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5, 12);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
  }
  return out;
}

// A commit's files against its first parent: `--name-status -z` and
// `--numstat -z` → [{ path, status, add, del, binary }].
export function parseCommitFiles(names, nums) {
  const stats = {};
  for (const entry of nums.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  const list = names.split("\0"), out = [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    const status = list[i].trim()[0], path = list[i + 1];
    if (!status || !path) continue;
    out.push({ path, status: status === "T" ? "M" : status, ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  return out;
}

// Each repository's base (origin's default branch), asked again after 5 min.
const BASES = new Map(), BASE_MS = 5 * 60000;
async function baseOf(root, on) {
  const k = `${on ?? ""}|${root}`, hit = BASES.get(k);
  if (hit && Date.now() - hit.at < BASE_MS) return hit.base;
  const base = await defaultBranch(root, on).catch(() => null);
  BASES.set(k, { base, at: Date.now() });
  return base;
}

// The graph's scopes: every branch, the checked-out branch's whole history,
// or only its own commits (since it forked from the base).
const SCOPES = ["all", "head", "branch"];

export class Git {
  init(cx) {
    this.root = null; this.branch = ""; this.worktrees = []; this.branches = []; this.rows = [];
    this.error = null; this.width = 400; this.height = 600;
    this.tab = ["graph", "branches", "worktrees"].includes(shared(TAB)) ? shared(TAB) : "graph";
    // "current" is what this setting was called before "branch" existed.
    const saved = shared(SCOPE) === "current" ? "head" : shared(SCOPE);
    this.scope = SCOPES.includes(saved) ? saved : "all";
    this.own = new Set(); this.base = null; this.fork = null;
    this.scroll = VirtualListScrollHandle.new();
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (!isShown(this.id)) { this.stale = true; return; }
    this.stale = false;
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.root = null; this.rows = []; this.worktrees = []; this.branches = []; this.error = null; this.watched = null; this.commit = null; this.toTop = true; }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args, dir = cwd) => exec("git", args, { cwd: dir, on });
        const top = await git(["rev-parse", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"]);
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.rows = []; this.worktrees = []; this.branches = []; this.error = "Not a git repository"; return; }
        const [root, common, head] = top.stdout.trim().split("\n");
        const commonDir = common.startsWith("/") ? common : `${root}/${common}`;
        const [wt, refs, remotes, base] = await Promise.all([
          git(["worktree", "list", "--porcelain"], root),
          git(["for-each-ref", "--sort=-committerdate", "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:relative)%00%(worktreepath)", "refs/heads"], root),
          git(["remote"], root),
          baseOf(root, on),
        ]);
        if (key() !== context) return;
        // The branch's own commits: on HEAD but not on the base (what a pull request holds).
        const branch = head === "HEAD" ? "" : head, baseRef = base ? `refs/remotes/origin/${base}` : null;
        const compare = Boolean(baseRef && branch && branch !== base);
        const scope = this.scope;
        const range = scope === "all" ? ["--branches", "--remotes", "--tags", "HEAD"] : scope === "branch" && compare ? [`${baseRef}..HEAD`] : ["HEAD"];
        const [log, own, fork] = await Promise.all([
          scope === "branch" && !compare ? Promise.resolve({ code: 0, stdout: "", stderr: "" })
            : git(["log", "--graph", "--date-order", "--color=never", `-n${Math.max(50, Math.min(2000, Number(cfg().git?.graphLimit) || 300))}`,
              "--format=%x01%h%x00%H%x00%D%x00%s%x00%ar%x00%an", ...range], root),
          compare ? git(["rev-list", "--max-count=2000", `${baseRef}..HEAD`], root) : null,
          compare ? git(["merge-base", "HEAD", baseRef], root) : null,
        ]);
        let forkInfo = null;
        if (fork?.code === 0 && fork.stdout.trim()) {
          const f = await git(["log", "-1", "--format=%h%x00%s%x00%ar", fork.stdout.trim()], root);
          if (f.code === 0) { const [sha, subject, when] = f.stdout.trim().split("\0"); forkInfo = { sha, subject, when }; }
        }
        if (key() !== context || scope !== this.scope) return;
        this.base = base; this.compare = compare; this.fork = forkInfo;
        this.own = new Set(own?.code === 0 ? own.stdout.split("\n").filter(Boolean) : []);
        REMOTES = remotes.code === 0 ? remotes.stdout.split("\n").filter(Boolean) : ["origin"];
        this.root = root; this.branch = head === "HEAD" ? "" : head; this.error = null;
        this.worktrees = wt.code === 0 ? parseWorktrees(wt.stdout) : [];
        this.branches = refs.code === 0 ? refs.stdout.split("\n").filter(Boolean).map((l) => {
          const [mark, name, upstream, track, when, worktree] = l.split("\0");
          const ahead = /ahead (\d+)/.exec(track)?.[1], behind = /behind (\d+)/.exec(track)?.[1];
          return { current: mark === "*", name, upstream, gone: track === "gone", ahead: Number(ahead ?? 0), behind: Number(behind ?? 0), when, worktree: worktree && worktree !== root ? worktree : "" };
        }).sort((a, b) => Number(b.current) - Number(a.current)) : [];
        const rows = log.code === 0 ? parseGraph(log.stdout) : [];
        // A virtual list left scrolled past its new, shorter content draws
        // nothing: back to the top (a frame later) when the graph shrinks or changes scope.
        if (this.toTop || rows.length < this.rows.length) {
          this.toTop = false; this.found = null;
          cx.timer.after(60, () => this.scroll?.scroll_to_item(0, "top"));
        }
        this.rows = rows;
        if (log.code !== 0 && !/does not have any commits/.test(log.stderr)) this.error = log.stderr.trim().split("\n")[0];
        this.watch(commonDir, context, cx);
      } catch (e) { if (key() === context) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // The repository's git folder (shared by its worktrees) changes on every
  // commit, checkout, fetch and branch: read again then (this computer only).
  watch(dir, context, cx) {
    if (location().on || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir && this.context === context) {
          await watchFolder(dir);
          if (this.watched !== dir || this.armed) continue;
          this.armed = cx.timer.after(500, (cx) => { this.armed = null; if (this.context === context) this.refresh(cx); });
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  setScope(scope, cx) { this.scope = scope; this.toTop = true; this.commit = null; setShared(SCOPE, scope); this.refresh(cx); cx.notify(); }

  // Puts a branch's tip in view in the graph.
  // What the graph shows now, in one line.
  scopeNote() {
    const n = this.own.size, own = `${n} commit${n === 1 ? "" : "s"} not on ${this.base}`;
    if (this.scope === "all") return this.compare ? `Every branch · highlighted: ${this.branch}'s ${own}` : "Every branch, remote branch and tag";
    if (this.scope === "head") return this.compare ? `${this.branch}'s whole history · highlighted: its ${own}` : "The checked-out branch's whole history";
    return this.compare ? `Only ${this.branch}'s own commits: ${own}` : "Only the branch's own commits";
  }

  emptyNote() {
    if (this.scope !== "branch") return "No commits yet";
    if (!this.base) return "origin has no default branch to compare with";
    if (!this.branch) return "HEAD is detached: check out a branch to see its own commits";
    if (this.branch === this.base) return `This is ${this.base}, the base itself`;
    return `Nothing on ${this.branch} that ${this.base} doesn't have`;
  }

  setTab(tab, cx) { this.tab = tab; setShared(TAB, tab); cx.notify(); }

  // Shows the graph with a branch's tip marked (the list mounts first, then scrolls).
  reveal(name, cx) {
    const i = this.rows.findIndex((r) => r.refs?.some((x) => x.name === name && x.kind !== "tag"));
    this.setTab("graph", cx);
    if (i < 0) return;
    this.found = i;
    cx.timer.after(60, () => this.scroll?.scroll_to_item(i, "center"));
  }

  openWorktree(path) {
    const space = spaces().find((s) => s.active)?.id;
    run("tab.new", { name: path.split("/").pop(), space, folder: path });
  }

  short(path) {
    const h = home();
    return !location().on && path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
  }

  graphCell(graph, t) {
    // Runs of characters in the same lane share one span (one lane = two columns).
    const spans = [];
    for (let i = 0; i < graph.length; i++) {
      const ch = graph[i], color = ch === " " ? null : t[LANES[Math.floor(i / 2) % LANES.length]];
      const last = spans[spans.length - 1];
      if (last && last.color === color) last.text += ch; else spans.push({ text: ch, color });
    }
    return h_flex().flex_none().children(spans.map((s) => div().flex_none().whitespace_nowrap().text_color(s.color ?? t.dim).child(s.text.replace(/\*/g, "●"))));
  }

  refChip(ref, t) {
    const color = ref.kind === "head" ? t.accent : ref.kind === "tag" ? t.ansi3 : ref.kind === "remote" ? t.ansi4 : t.ansi2;
    return div().flex_none().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(color + "70").bg(color + "1c")
      .text_size(10.5).text_color(color).when(ref.kind === "head", (e) => e.font_semibold())
      .child(ref.kind === "head" && ref.name !== "HEAD" ? `● ${ref.name}` : ref.name);
  }

  // Lists a commit's files (one click on its row; again closes it).
  openCommit(r, cx) {
    if (this.commit?.sha === r.sha) { this.commit = null; cx.notify(); return; }
    const root = this.root, context = this.context, on = location().on;
    this.commit = { sha: r.sha, subject: r.subject, author: r.author, when: r.when, files: null, error: null };
    const want = this.commit;
    cx.spawn(async (cx) => {
      try {
        const show = (fmt) => exec("git", ["show", "--format=", "--no-renames", "--diff-merges=first-parent", fmt, "-z", r.sha], { cwd: root, on });
        const [names, nums] = await Promise.all([show("--name-status"), show("--numstat")]);
        if (this.commit !== want || this.context !== context) return;
        if (names.code !== 0) throw new Error((names.stderr || "git show failed").trim().split("\n")[0]);
        want.files = parseCommitFiles(names.stdout, nums.code === 0 ? nums.stdout : "").slice(0, 1000);
      } catch (e) { if (this.commit === want) want.error = String(e?.message ?? e); }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  // One of the commit's files side by side: its first parent left, the commit right.
  openCommitFile(f) {
    const c = this.commit, on = location().on ?? null;
    const one = (x) => ({ root: this.root, path: x.path, on, rev: c.sha, status: x.status, hasHead: true });
    openOverlay({ mod: "toolkit-panel", kind: "dialog", width: 0.94, height: 0.9,
      props: { panel: "diff", ...one(f), files: c.files.filter((x) => insideRoot(x.path)).map(one) } });
  }

  commitFileRow(f, i, t) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`git-cf-${i}`).h(LIST).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip("Compare with the parent side by side").on_click(() => this.openCommitFile(f))
      .child(div().w(14).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // The picked commit under the graph: what it is, then its files.
  commitView(t) {
    const c = this.commit, files = c.files ?? [];
    // Up to 45% of the panel; the graph keeps the rest.
    const h = Math.min(Math.max(1, files.length) * LIST + 8, Math.max(3 * LIST, Math.round(this.height * 0.45)));
    return v_flex().flex_none().border_t(2).border_color(t.accent + "88").bg(t.raised)
      .child(h_flex().h(34).flex_none().px(14).gap(8).items_center()
        .child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.accent + "26").text_size(10).font_semibold().text_color(t.accent).child("COMMIT"))
        .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.muted).child(c.sha))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(c.subject))
        .child(div().id("git-commit-close").p(3).rounded(5).flex_none().cursor_pointer().text_color(t.muted).tooltip("Close")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.commit = null; cx.notify(); })
          .child(svg(`${ICON}close.svg`).size(12))))
      .child(div().px(14).pb(4).truncate().text_size(11).text_color(t.dim)
        .child(`${c.author} · ${c.when}${c.files ? ` · ${files.length} file${files.length === 1 ? "" : "s"}` : ""}`))
      .child(c.error ? div().px(14).pb(8).text_size(12).text_color(t.ansi1).child(c.error)
        : !c.files ? div().px(14).pb(8).text_size(12).text_color(t.dim).child("Reading…")
        : v_flex().id("git-commit-files").h(h).overflow_y_scrollbar().px(6).py(4).bg(t.background).border_t(1).border_color(t.border)
          .children(files.map((f, i) => this.commitFileRow(f, i, t)))
          .when(!files.length, (e) => e.child(div().px(8).text_size(12).text_color(t.dim).child("No file changes (an empty or merge-only commit)"))));
  }

  graphRow(r, i, t) {
    const picked = Boolean(r.sha) && this.commit?.sha === r.sha;
    // The branch's own commits stand out among the others (all of them are, in "Since base").
    const mine = this.scope !== "branch" && Boolean(r.full) && this.own.has(r.full);
    const row = h_flex().id(`git-row-${i}`).w(this.width).h(ROW).flex_none().px(10).gap(6).items_center().overflow_hidden()
      .when(mine, (e) => e.bg(t.accent + "16"))
      .when(this.found === i || picked, (e) => e.bg(t.selected))
      .child(this.graphCell(r.graph, t));
    if (!r.sha) return row;
    // The click is the list's on_item_click: a handler inside a virtual list's renderer throws.
    return row.cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${r.sha} · ${r.author} · ${r.when}\n${r.subject}\nClick: its files`)
      .child(div().flex_none().text_color(mine || this.scope === "branch" ? t.accent : t.dim).child(r.sha))
      .children(r.refs.map((ref) => this.refChip(ref, t)))
      .child(div().flex_1().min_w(0).truncate().child(r.subject))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.when.replace(/ ago$/, "")));
  }

  branchRow(b, t) {
    const status = [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : "", b.gone ? "gone" : ""].filter(Boolean).join(" ");
    return h_flex().id(`git-branch-${b.name}`).h(32).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(b.current, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip([b.name, b.upstream ? `tracks ${b.upstream}` : "no upstream", b.worktree ? `checked out in ${this.short(b.worktree)}` : "", b.when].filter(Boolean).join("\n"))
      .on_click((_e, cx) => this.reveal(b.name, cx))
      .child(div().w(10).flex_none().text_color(b.current ? t.accent : t.dim).child(b.current ? "●" : b.worktree ? "◐" : "○"))
      .child(div().min_w(0).flex_shrink(1).truncate().when(b.current, (e) => e.font_semibold()).child(b.name))
      .child(div().flex_1())
      .when(Boolean(status), (e) => e.child(div().flex_none().text_size(11).text_color(b.gone ? t.ansi1 : t.accent).child(status)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(b.when.replace(/ ago$/, "")));
  }

  worktreeRow(w, t) {
    const here = w.path === this.root;
    return h_flex().id(`git-wt-${w.path}`).h(44).flex_none().px(10).gap(10).items_center().rounded(6)
      .when(here, (e) => e.bg(t.selected)).when(!here && !w.bare, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openWorktree(w.path)))
      .tooltip(here ? `${w.path}\nthis pane's worktree` : `${w.path}\nclick: open a tab here`)
      .child(svg(`${ICON}${here ? "monitor" : "branch"}.svg`).size(14).flex_none().text_color(here ? t.accent : t.muted))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().when(here, (e) => e.font_semibold()).child(w.bare ? "(bare)" : w.detached ? `detached ${w.head}` : w.branch || w.head))
          .when(here, (e) => e.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).bg(t.accent + "26").text_size(10).text_color(t.accent).child("this pane"))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.short(w.path))));
  }

  render(cx) {
    if (isShown(this.id) && (this.stale || key() !== this.context)) this.refresh(cx);
    const t = theme(), name = this.root?.split("/").pop();
    const chip = (id, label, on, action) => div().id(id).h(22).px(8).flex().items_center().rounded(11).text_size(11).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected)).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(label);
    // Graph · Branches · Worktrees: one at a time, each with the panel's full height.
    const wts = this.worktrees.length > 1;
    const tab = this.tab === "worktrees" && !wts ? "graph" : this.tab;
    const tabButton = (id, label, count) => {
      const on = tab === id;
      return v_flex().id(`git-tab-${id}`).h_full().px(10).flex_none().justify_center().cursor_pointer()
        .border_b(2).border_color(on ? t.accent : "#00000000").hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setTab(id, cx))
        .child(h_flex().gap(5).items_center()
          .child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).when(on, (e) => e.font_semibold()).child(label))
          .when(count !== null, (e) => e.child(div().px(5).h(16).flex().items_center().rounded(8).bg(t.raised).text_size(10).text_color(t.dim).child(String(count)))));
    };
    const empty = (text) => div().px(14).py(12).text_size(12).text_color(t.dim).child(text);
    const graph = () => v_flex().flex_1().min_h(0)
      .child(h_flex().h(36).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(chip("git-scope-all", "All branches", this.scope === "all", (cx) => this.setScope("all", cx)))
        .child(chip("git-scope-head", "This branch", this.scope === "head", (cx) => this.setScope("head", cx)))
        .child(chip("git-scope-branch", this.base ? `Since ${this.base}` : "Since base", this.scope === "branch", (cx) => this.setScope("branch", cx))))
      .child(div().px(14).py(4).flex_none().truncate().text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
        .child(this.scopeNote()))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
        .child(v_virtual_list("git-graph", this.rows.length, ROW, (i) => String(i),
          (range) => this.rows.slice(range.start, range.end).map((r, k) => this.graphRow(r, range.start + k, t))).track_scroll(this.scroll).size_full()
          .on_item_click((k, cx) => { const r = this.rows[Number(k)]; if (r?.sha) this.openCommit(r, cx); }))
        .child(Scrollbar.vertical("git-graph").viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, (e) => e.child(div().absolute().top(6).px(14).text_color(t.dim).child(this.error ?? this.emptyNote()))))
      .when(this.scope === "branch" && Boolean(this.fork), (e) => e.child(h_flex().h(28).flex_none().px(14).gap(6).items_center().border_t(1).border_color(t.border)
        .text_size(11).text_color(t.dim).tooltip(`${this.fork.sha} ${this.fork.subject}\n${this.fork.when}`)
        .child(div().flex_none().child(`⑂ forked from ${this.base} at`))
        .child(div().flex_none().text_color(t.muted).child(this.fork.sha))
        .child(div().min_w(0).truncate().child(this.fork.subject))))
      .when(Boolean(this.commit), (e) => e.child(this.commitView(t)));
    const branches = () => v_flex().id("git-branches").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .child(div().px(8).pb(4).text_size(11).text_color(t.dim).child("Newest first. ● checked out · ◐ in another worktree · click: show in the graph"))
      .children(this.branches.map((b) => this.branchRow(b, t)))
      .when(!this.branches.length, (e) => e.child(empty("No local branches")));
    const worktrees = () => v_flex().id("git-worktrees").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .child(div().px(8).pb(4).text_size(11).text_color(t.dim).child("Click another worktree to open a tab in it"))
      .children(this.worktrees.map((w) => this.worktreeRow(w, t)));
    return v_flex().id("git").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        if (size.width !== this.width || size.height !== this.height) { this.width = size.width; this.height = size.height; cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Git"))
        .when(Boolean(name), (e) => e.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(name)))
        .child(div().flex_1())
        .when(Boolean(this.root), (e) => e.child(h_flex().id("git-head").h(22).px(8).gap(5).flex_none().items_center().rounded(11).bg(t.selected)
          .tooltip(this.branch ? `Checked out: ${this.branch}` : "HEAD is detached")
          .child(svg(`${ICON}branch.svg`).size(12).text_color(t.accent))
          .child(div().max_w(180).truncate().text_size(12).child(this.branch || "detached"))))
        .child(div().id("git-refresh").p(4).rounded(6).cursor_pointer().text_color(t.muted).tooltip("Read again")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx)).child(svg(`${ICON}refresh.svg`).size(14))))
      .when(!this.root, (e) => e.child(empty(this.error ?? (this.loading ? "Reading…" : "No folder"))))
      .when(Boolean(this.root), (e) => e
        .child(h_flex().h(36).flex_none().px(4).items_end().border_b(1).border_color(t.border).bg(t.chrome ?? t.background)
          .child(tabButton("graph", "Graph", null))
          .child(tabButton("branches", "Branches", this.branches.length))
          .when(wts, (e) => e.child(tabButton("worktrees", "Worktrees", this.worktrees.length))))
        .child(tab === "graph" ? graph() : tab === "branches" ? branches() : worktrees()));
  }
}
