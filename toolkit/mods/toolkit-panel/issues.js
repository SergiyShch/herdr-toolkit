// The focused session's repository's open GitHub issues, read with the GitHub
// CLI (`gh issue list`) only while the panel is shown. Drawn like the PR panel
// (Kanso's Spend style): one column, hierarchy from size and tone, hairlines.
//
// A click on a row opens the issue in the browser. Each row also offers
// "Start": a new tab, named after the issue (#123), running your agent with
// the issue as its first message. The tab's name counts as typed, so it stays.
// Groups: this branch (its name mentions the number), assigned to you, opened
// by you, everyone else. A search field filters by title, number, label or
// author.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Input, InputState } from "gpui-base";
import { exec, theme } from "herdr";
import { location, key, isShown, ICON, G, tokens, ago, clock, labelColor, openUrl, startAgent, cfg, prompt, ghAs, ghAccount, forgetGhAccount, noAccess, NOT_FOUND, ghLogins, accountPicker, jiraChips } from "./lib.js";

const FIELDS = "number,title,url,author,assignees,labels,updatedAt,comments,milestone";
const limit = () => Math.max(1, Math.min(500, Number(cfg().issues.limit) || 100));

const PROMPT = (i) => `Work on GitHub issue #${i.number} (${i.url}): ${i.title}. Read it first with \`gh issue view ${i.url} --comments\`. Restate the problem and your plan, check the relevant code, then make the change on a branch named after the issue (for example \`${i.number}-<short-slug>\`), with tests where the repository has them. Do not push or open a pull request until I say so.`;

// The issue a branch is about, if its name carries one: "123-fix", "fix/123-x", "issue-123", "gh-123".
export function branchIssue(branch) {
  const m = /(?:^|[/_-])(?:issue-|issues-|gh-|#)?(\d{1,6})(?=[-_/]|$)/i.exec(branch ?? "");
  return m ? Number(m[1]) : null;
}

export class Issues {
  init(cx) {
    this.list = []; this.query = "";
    this.search = InputState.new({ placeholder: "Filter issues" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(15000, (cx) => { if (!this.accountOpen && Date.now() - (this.loadedAt ?? 0) > cfg().issues.refreshSeconds * 1000 - 5000) this.refresh(cx); });
  }

  reload(cx) { this.loadedAt = 0; this.refresh(cx); }
  gh(args) { return ghAs(this.account ?? "", args, { cwd: this.root ?? this.cwd, on: this.on }); }

  refresh(cx) {
    if (!isShown(this.id)) { this.stale = true; return; }
    this.stale = false;
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.branch = null; this.repo = null; this.list = [];
      this.error = null; this.outside = false; this.loadedAt = 0;
    }
    if (!cwd) return;
    this.cwd = cwd; this.on = on; this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.outside = true; this.list = []; this.error = null; return; }
        this.outside = false; this.root = top.stdout.trim();
        const branch = await exec("git", ["branch", "--show-current"], { cwd: this.root, on }).catch(() => null);
        this.branch = branch?.stdout.trim() || null;
        const who = await ghAccount(this.root, on);
        if (key() !== context) return;
        this.account = who.account; this.ghRepo = who.repo; this.pinned = who.pinned;
        this.logins = await ghLogins(on);
        if (who.repo) this.repo = `${who.repo.owner}/${who.repo.name}`;
        let r;
        try { r = await this.gh(["issue", "list", "--state", "open", "--limit", String(limit()), "--json", FIELDS]); }
        catch { this.error = { title: "The GitHub CLI is not installed.", detail: "Install gh and run `gh auth login`." }; return; }
        if (key() !== context) return;
        if (r.code !== 0) {
          const why = (r.stderr || r.stdout).trim().split("\n")[0];
          if (NOT_FOUND.test(why) && this.ghRepo && !this.pinned) forgetGhAccount(this.root, on, this.ghRepo);
          this.error = /disabled issues/i.test(why) ? { title: "Issues are turned off for this repository." }
            : NOT_FOUND.test(why) && this.ghRepo ? { title: "GitHub could not be read.", detail: noAccess(this.ghRepo, this.account) }
            : { title: "GitHub could not be read.", detail: why };
          this.list = []; return;
        }
        this.list = JSON.parse(r.stdout).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        this.repo = /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(this.list[0]?.url ?? "")?.[1] ?? this.repo;
        this.error = null;
        if (!this.viewer) {
          const me = await this.gh(["api", "user", "--jq", ".login"]).catch(() => null);
          if (me?.code === 0) this.viewer = me.stdout.trim();
        }
      } catch (e) { if (key() === context) this.error = { title: "GitHub could not be read.", detail: String(e?.message ?? e) }; }
      finally { this.loading = false; this.loadedAt = Date.now(); cx.notify(); }
    });
  }

  start(issue) {
    const vars = { number: issue.number, url: issue.url, title: issue.title, head: this.branch ?? "", base: "" };
    startAgent({ name: `#${issue.number}`, space: location().space, folder: this.root ?? this.cwd, on: this.on, task: prompt("issue", vars, PROMPT(issue)) });
  }

  filtered() {
    const q = this.query.trim().toLowerCase().replace(/^#/, "");
    if (!q) return this.list;
    return this.list.filter((i) => String(i.number).startsWith(q) || i.title.toLowerCase().includes(q)
      || i.author?.login?.toLowerCase().includes(q) || (i.labels ?? []).some((l) => l.name.toLowerCase().includes(q)));
  }

  iconButton(id, icon, tip, onClick, c) {
    return Button.new(id).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .accessibility_label(tip).tooltip(tip).hover((s) => s.bg(c.subtle))
      .on_click((_e, cx) => onClick(cx))
      .child(svg(`${ICON}${icon}.svg`).size(15).text_color(c.muted));
  }

  section(c, title, note) {
    return h_flex().w_full().items_end().justify_between().pb(G.sm)
      .child(div().text_size(15).text_color(c.text).child(title))
      .child(div().text_size(12).text_color(c.dim).child(note ?? ""));
  }

  row(issue, i, c) {
    const me = this.viewer;
    const meta = [`#${issue.number}`, issue.author?.login === me ? "you" : issue.author?.login, `updated ${ago(issue.updatedAt)}`,
      issue.comments?.length ? `${issue.comments.length} comment${issue.comments.length > 1 ? "s" : ""}` : null,
      issue.milestone?.title].filter(Boolean).join(" · ");
    const assignees = (issue.assignees ?? []).map((a) => (a.login === me ? "you" : a.login));
    return Button.new(`issue-${i}`).w_full().px(G.md).py(10).rounded(6).cursor_pointer()
      .hover((s) => s.bg(c.subtle))
      .accessibility_label(`#${issue.number} ${issue.title}, opens in the browser`)
      .tooltip("Open in browser")
      .on_click(() => openUrl(issue.url))
      .child(v_flex().w_full().min_w(0).gap(5)
        .child(h_flex().w_full().items_start().gap(G.md)
          .child(div().flex_1().min_w(0).text_size(14).line_height(1.35).text_color(c.text).child(issue.title))
          .when(cfg().issues.startButton, (el) => el.child(Button.new(`issue-start-${i}`).h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
            .border_1().border_color(c.border).hover((s) => s.bg(c.selected))
            .accessibility_label(`Start an agent on #${issue.number}`).tooltip("Start your agent on it, in a new tab")
            .on_click((_e, cx) => { cx.stop_propagation(); this.start(issue); })
            .child(svg(`${ICON}agent.svg`).size(12).text_color(c.muted))
            .child(div().text_size(11.5).text_color(c.text).child("Start")))))
        .child(div().w_full().truncate().text_size(11.5).text_color(c.dim).child(meta))
        .when(true, (el) => { const jira = jiraChips(`issue-${i}`, issue.title, c); return jira.length ? el.child(h_flex().flex_wrap().gap(6).children(jira)) : el; })
        .when(assignees.length > 0 || (issue.labels ?? []).length > 0, (el) => el.child(h_flex().w_full().flex_wrap().gap(6).items_center()
          .when(assignees.length > 0, (el) => el.child(div().text_size(11.5).text_color(c.muted).child(`→ ${assignees.join(", ")}`)))
          .children((issue.labels ?? []).slice(0, 6).map((l) => {
            const color = labelColor(l.color) ?? c.dim;
            return h_flex().h(20).px(7).gap(5).items_center().rounded(6).bg(color + "26")
              .child(div().size(6).rounded_full().bg(color))
              .child(div().max_w(140).truncate().text_size(11).text_color(c.text).child(l.name));
          })))));
  }

  waiting(c, title, detail, retry) {
    return v_flex().w_full().gap(G.sm)
      .child(div().text_size(15).text_color(this.error ? c.red : c.muted).child(title))
      .when(Boolean(detail), (el) => el.child(div().text_size(12).text_color(c.dim).child(detail)))
      .when(Boolean(retry), (el) => el.child(h_flex().pt(G.xs).child(Button.new("issues-retry").h(24).cursor_pointer()
        .on_click((_e, cx) => { this.loadedAt = 0; this.refresh(cx); })
        .child(div().text_size(12).text_color(c.muted).child("Try again")))));
  }

  skeleton(c) {
    const block = (w, h) => div().w(w).h(h).flex_none().rounded(3).bg(c.border);
    return v_flex().w_full().gap(G.lg).loop("opacity", { from: 0.35, to: 0.8, period: 1800 })
      .children([220, 170, 250, 190, 140].map((w, i) => v_flex().id(`issues-ghost-${i}`).gap(6).px(G.md).child(block(w, 12)).child(block(120, 9))));
  }

  render(cx) {
    if (isShown(this.id) && (this.stale || key() !== this.context)) this.refresh(cx);
    const c = tokens(theme());
    const me = this.viewer, here = branchIssue(this.branch);
    const list = this.filtered();
    const mine = (i) => Boolean(me) && (i.assignees ?? []).some((a) => a.login === me);
    const opened = (i) => Boolean(me) && i.author?.login === me;
    const groups = [
      ["This branch", list.filter((i) => i.number === here)],
      ["Assigned to you", list.filter((i) => i.number !== here && mine(i))],
      ["Opened by you", list.filter((i) => i.number !== here && !mine(i) && opened(i))],
      [me ? "Everyone else" : "Open", list.filter((i) => i.number !== here && !mine(i) && !opened(i))],
    ].filter(([, rows]) => rows.length);

    let body;
    if (this.outside) body = this.waiting(c, "No repository here", "Focus a pane inside a git repository to see its issues.");
    else if (this.error) body = this.waiting(c, this.error.title, this.error.detail, true);
    else if (!this.loadedAt && this.loading) body = this.skeleton(c);
    else if (!this.list.length) body = this.waiting(c, this.cwd ? "No open issues." : "No folder", this.cwd ? null : "Focus a pane inside a repository.");
    else {
      let n = 0;
      body = v_flex().w_full().gap(G.xl)
        .children(groups.map(([title, rows]) => v_flex().w_full().gap(2)
          .child(this.section(c, title, String(rows.length)))
          .children(rows.map((issue) => this.row(issue, n++, c)))))
        .when(!list.length, (el) => el.child(div().text_size(13).text_color(c.dim).child("No issue matches that.")))
        .when(this.list.length >= limit(), (el) => el.child(div().text_size(11).text_color(c.dim).child(`The ${limit()} most recently updated; the rest are on GitHub.`)));
    }

    const repoUrl = this.repo ? `https://github.com/${this.repo}/issues` : null;
    return v_flex().id("toolkit-issues").size_full().min_h(0).bg(c.canvas).text_color(c.text).overflow_y_scrollbar()
      .child(v_flex().w_full().px(G.lg).py(G.lg).gap(G.xl)
        .child(h_flex().w_full().items_center().justify_between().gap(G.md)
          .child(h_flex().gap(G.sm).items_end().min_w(0)
            .child(div().text_size(17).text_color(c.text).child("Issues"))
            .when(this.list.length > 0, (el) => el.child(div().pb(2).text_size(12).text_color(c.dim).child(`${this.list.length} open`))))
          .child(h_flex().gap(G.xs).items_center().flex_none()
            .when(Boolean(this.root) && !this.outside, (el) => el.child(accountPicker(this, c, "issues")))
            .child(Button.new("issues-refresh").size(26).items_center().justify_center().rounded(6).cursor_pointer()
              .tooltip(this.loadedAt ? `Refresh · updated ${clock(this.loadedAt)}` : "Refresh").hover((s) => s.bg(c.subtle))
              .on_click((_e, cx) => { this.loadedAt = 0; this.refresh(cx); })
              .child(this.loading ? svg(`${ICON}refresh.svg`).size(15).text_color(c.text).spin(900) : svg(`${ICON}refresh.svg`).size(15).text_color(c.muted)))
            .when(Boolean(repoUrl), (el) => el.child(this.iconButton("issues-web", "external", "Open issues on GitHub", () => openUrl(repoUrl), c)))))
        .when(this.list.length > 0, (el) => el.child(div().h(30).flex_none().px(10).flex().items_center().rounded(6).border_1().border_color(c.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(c.text))))
        .child(body)
        .when(Boolean(this.loadedAt) && !this.error && !this.outside, (el) => el.child(div().text_size(10.5).text_color(c.dim)
          .child(`Read from GitHub with gh${this.account ? ` as ${this.account}` : ""} · updated ${clock(this.loadedAt)}. Rereads every ${cfg().issues.refreshSeconds} s while shown.`))));
  }
}
