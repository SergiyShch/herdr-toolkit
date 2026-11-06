// The repository's shape at a glance: its worktrees (the pane's one marked),
// its local branches (the checked-out one first, with ↑ahead ↓behind its
// upstream) and the commit graph (`git log --graph`) with branch and tag
// labels. Click a branch to find its tip in the graph; click another
// worktree to open a tab there. Reads git only; it never checks anything out.
// New for herdr-serhii.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, watchFolder, theme, settings, home, run, spaces, shared, setShared } from "herdr";
import { location, key, isShown, cfg, ICON } from "./lib.js";

const ROW = 22, LIST = 26, SCOPE = "serhii.gitScope";
// Graph columns take the terminal's hues in turn.
const LANES = ["ansi4", "ansi2", "ansi5", "ansi3", "ansi6", "ansi1"];

// `git log --graph` lines → { graph, sha, refs, subject, when, author } (a
// line with no commit only carries graph, the lines between commits).
export function parseGraph(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf("\x01");
    if (at < 0) return { graph: line.replace(/\s+$/, "") };
    const [sha, refs, subject, when, author] = line.slice(at + 1).split("\x00");
    return { graph: line.slice(0, at).replace(/\s+$/, ""), sha, refs: parseRefs(refs ?? ""), subject: subject ?? "", when: when ?? "", author: author ?? "" };
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

export class Git {
  init(cx) {
    this.root = null; this.branch = ""; this.worktrees = []; this.branches = []; this.rows = [];
    this.error = null; this.width = 400; this.foldBranches = false;
    this.all = shared(SCOPE) !== "current";
    this.scroll = VirtualListScrollHandle.new();
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (!isShown(this.id)) { this.stale = true; return; }
    this.stale = false;
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.root = null; this.rows = []; this.worktrees = []; this.branches = []; this.error = null; this.watched = null; }
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
        const [wt, refs, remotes, log] = await Promise.all([
          git(["worktree", "list", "--porcelain"], root),
          git(["for-each-ref", "--sort=-committerdate", "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:relative)%00%(worktreepath)", "refs/heads"], root),
          git(["remote"], root),
          git(["log", "--graph", "--date-order", "--color=never", `-n${Math.max(50, Math.min(2000, Number(cfg().git?.graphLimit) || 300))}`,
            "--format=%x01%h%x00%D%x00%s%x00%ar%x00%an", ...(this.all ? ["--branches", "--remotes", "--tags", "HEAD"] : ["HEAD"])], root),
        ]);
        if (key() !== context) return;
        REMOTES = remotes.code === 0 ? remotes.stdout.split("\n").filter(Boolean) : ["origin"];
        this.root = root; this.branch = head === "HEAD" ? "" : head; this.error = null;
        this.worktrees = wt.code === 0 ? parseWorktrees(wt.stdout) : [];
        this.branches = refs.code === 0 ? refs.stdout.split("\n").filter(Boolean).map((l) => {
          const [mark, name, upstream, track, when, worktree] = l.split("\0");
          const ahead = /ahead (\d+)/.exec(track)?.[1], behind = /behind (\d+)/.exec(track)?.[1];
          return { current: mark === "*", name, upstream, gone: track === "gone", ahead: Number(ahead ?? 0), behind: Number(behind ?? 0), when, worktree: worktree && worktree !== root ? worktree : "" };
        }).sort((a, b) => Number(b.current) - Number(a.current)) : [];
        this.rows = log.code === 0 ? parseGraph(log.stdout) : [];
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

  setScope(all, cx) { this.all = all; setShared(SCOPE, all ? "all" : "current"); this.refresh(cx); cx.notify(); }

  // Puts a branch's tip in view in the graph.
  reveal(name) {
    const i = this.rows.findIndex((r) => r.refs?.some((x) => x.name === name && x.kind !== "tag"));
    if (i >= 0) { this.found = i; this.scroll.scroll_to_item(Math.max(0, i - 2), "top"); }
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

  graphRow(r, i, t) {
    const row = h_flex().id(`git-row-${i}`).w(this.width).h(ROW).flex_none().px(10).gap(6).items_center().overflow_hidden()
      .when(this.found === i, (e) => e.bg(t.selected))
      .child(this.graphCell(r.graph, t));
    if (!r.sha) return row;
    return row.tooltip(`${r.sha} · ${r.author} · ${r.when}\n${r.subject}`)
      .child(div().flex_none().text_color(t.dim).child(r.sha))
      .children(r.refs.map((ref) => this.refChip(ref, t)))
      .child(div().flex_1().min_w(0).truncate().child(r.subject))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.when.replace(/ ago$/, "")));
  }

  branchRow(b, t) {
    const status = [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : "", b.gone ? "gone" : ""].filter(Boolean).join(" ");
    return h_flex().id(`git-branch-${b.name}`).h(LIST).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(b.current, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip([b.name, b.upstream ? `tracks ${b.upstream}` : "no upstream", b.worktree ? `checked out in ${this.short(b.worktree)}` : "", b.when].filter(Boolean).join("\n"))
      .on_click(() => this.reveal(b.name))
      .child(div().w(10).flex_none().text_color(b.current ? t.accent : t.dim).child(b.current ? "●" : b.worktree ? "◐" : "○"))
      .child(div().min_w(0).flex_shrink(1).truncate().when(b.current, (e) => e.font_semibold()).child(b.name))
      .child(div().flex_1())
      .when(Boolean(status), (e) => e.child(div().flex_none().text_size(11).text_color(b.gone ? t.ansi1 : t.accent).child(status)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(b.when.replace(/ ago$/, "")));
  }

  worktreeRow(w, t) {
    const here = w.path === this.root;
    return h_flex().id(`git-wt-${w.path}`).h(LIST).flex_none().px(8).gap(6).items_center().rounded(6)
      .when(here, (e) => e.bg(t.selected)).when(!here && !w.bare, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openWorktree(w.path)))
      .tooltip(here ? `${w.path}\nthis pane's worktree` : `${w.path}\nclick: open a tab here`)
      .child(svg(`${ICON}${here ? "monitor" : "branch"}.svg`).size(13).flex_none().text_color(here ? t.accent : t.muted))
      .child(div().flex_none().max_w(160).truncate().when(here, (e) => e.font_semibold()).child(w.bare ? "(bare)" : w.detached ? `detached ${w.head}` : w.branch || w.head))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.short(w.path)));
  }

  render(cx) {
    if (isShown(this.id) && (this.stale || key() !== this.context)) this.refresh(cx);
    const t = theme(), name = this.root?.split("/").pop();
    const heading = (label, extra) => h_flex().h(24).flex_none().px(14).gap(6).items_center().text_size(11).text_color(t.muted).child(div().font_semibold().child(label)).child(extra ?? div());
    const scope = (id, label, on, action) => div().id(id).h(20).px(7).flex().items_center().rounded(10).text_size(11).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.selected)).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(label);
    const others = this.branches.length;
    const listH = Math.min(this.foldBranches ? 0 : 8, others) * LIST;
    return v_flex().id("git").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
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
      .when(!this.root, (e) => e.child(div().p(14).text_color(t.dim).child(this.error ?? (this.loading ? "Reading…" : "No folder"))))
      .when(Boolean(this.root), (e) => e
        .when(this.worktrees.length > 1, (e) => e.child(v_flex().flex_none().pt(6).pb(4).border_b(1).border_color(t.border)
          .child(heading(`Worktrees · ${this.worktrees.length}`))
          .child(v_flex().id("git-worktrees").max_h(4 * LIST + 4).overflow_y_scrollbar().px(6)
            .children(this.worktrees.map((w) => this.worktreeRow(w, t))))))
        .child(v_flex().flex_none().pt(6).pb(4).border_b(1).border_color(t.border)
          .child(div().id("git-branches-head").cursor_pointer().on_click((_e, cx) => { this.foldBranches = !this.foldBranches; cx.notify(); })
            .child(heading(`Branches · ${others}`, svg(`mods/serhii-panel/chevron-${this.foldBranches ? "right" : "down"}.svg`).size(11).text_color(t.dim))))
          .when(!this.foldBranches, (e) => e.child(v_flex().id("git-branches").h(listH + 4).overflow_y_scrollbar().px(6)
            .children(this.branches.map((b) => this.branchRow(b, t))))))
        .child(h_flex().h(30).flex_none().px(14).gap(6).items_center()
          .child(div().text_size(11).font_semibold().text_color(t.muted).child("Graph"))
          .child(div().flex_1())
          .child(scope("git-scope-all", "All branches", this.all, (cx) => this.setScope(true, cx)))
          .child(scope("git-scope-head", "This branch", !this.all, (cx) => this.setScope(false, cx))))
        .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
          .child(v_virtual_list("git-graph", this.rows.length, ROW, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((r, k) => this.graphRow(r, range.start + k, t))).track_scroll(this.scroll).size_full())
          .child(Scrollbar.vertical("git-graph").viewport_from_layout().absolute().inset_0())
          .when(!this.rows.length, (e) => e.child(div().absolute().top(6).px(14).text_color(t.dim).child(this.error ?? "No commits yet"))))
      );
  }
}
