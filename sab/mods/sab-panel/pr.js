// Kanso's pull request panel, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// One pull request at a time: the focused pane's branch's own, else the newest
// open one in that repository; "N open" in the header turns the panel to a page
// of every open one, by anyone, and a click there shows it,
// read with the GitHub CLI (`gh`), in the spirit of T3 Code's pull request view and drawn the way the
// Spend panel is: one centered column, no cards or uppercase labels, hierarchy
// from type size, weight and tone, hairlines between rows, a breathing
// silhouette while it loads.
//
// What it shows: state, readiness, size, assignees, reviewers and labels (each
// with T3 Code's candidate picker: search, a check on what is applied, a click
// toggles it and the picker stays open), checks, unresolved review threads and
// the files with their diff. What it does: merge (a second press confirms),
// mark ready or back to draft, close or reopen, open it on GitHub, assign it to
// you, and hand a task (explain, address feedback, resolve conflicts) to your
// agent in a new tab. A branch without one offers to create it.
//
// Modified for herdr-sab: one of the sab-panel mod's panels (reads only while
// shown); adds Code review and Describe change agent tasks, and an open-in-browser
// button on each row of the open list.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, Input, InputState, TextView } from "gpui-base";
import { exec, notify, theme } from "herdr";
import { location, key, diffRows, isShown, ICON, G, tokens, ago, clock, labelColor, openUrl, startAgent, cfg, prompt, ghAs, ghAccount, forgetGhAccount, noAccess, NOT_FOUND, ghLogins, accountPicker, jiraChips, linkJira } from "./lib.js";

const FIELDS = "number,title,body,state,isDraft,url,author,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,latestReviews,reviewRequests,assignees,labels,additions,deletions,changedFiles,files,comments,updatedAt";
const THREADS = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:1){totalCount nodes{author{login} body url}}}}}}}";
// T3 Code's candidate reads: assignableUsers is GitHub's own picker list (everyone with access),
// which, unlike `collaborators`, does not need push access to read.
const PEOPLE = "query($o:String!,$r:String!){viewer{login} repository(owner:$o,name:$r){assignableUsers(first:100){pageInfo{hasNextPage} nodes{login name}}}}";
const LABELS = "query($o:String!,$r:String!){repository(owner:$o,name:$r){labels(first:100,orderBy:{field:NAME,direction:ASC}){pageInfo{hasNextPage} nodes{name color description}}}}";
// Every open pull request of this repository, by anyone: the list a click picks from.
const OPEN = "number,title,url,isDraft,updatedAt,author,headRefName,baseRefName,reviewDecision,statusCheckRollup,additions,deletions,labels,comments";
const NO_PR = /no (open )?pull requests? found|could not determine current branch/i;
const MAX_DIFF = 400;
const FILE_ROWS = 8;
// The description folds to this height when it is longer than a few lines.
const BODY_FOLD = 150;

// A pull request's body as Markdown to show: no template comments, no Windows line ends.
export function cleanBody(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
// Whether it is long enough to fold: more than 6 lines or 480 characters.
export const longBody = (text) => text.split("\n").length > 6 || text.length > 480;


// One check, as either kind GitHub reports: a check run or a commit status.
function checkOf(c) {
  if (c.__typename === "StatusContext") {
    const st = (c.state ?? "").toUpperCase();
    return { name: c.context, url: c.targetUrl, state: st === "SUCCESS" ? "pass" : st === "PENDING" || st === "EXPECTED" ? "pending" : "fail" };
  }
  const conclusion = (c.conclusion ?? "").toUpperCase();
  const state = (c.status ?? "").toUpperCase() !== "COMPLETED" ? "pending"
    : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) ? "pass" : "fail";
  return { name: c.name, workflow: c.workflowName && c.workflowName !== c.name ? c.workflowName : "", url: c.detailsUrl, state, skipped: conclusion === "SKIPPED" };
}

function splitDiff(text) {
  const out = {};
  let lines = null;
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (head) { lines = out[head[1]] = []; continue; }
    if (lines && (lines.length || line.startsWith("@@"))) lines.push(line);
  }
  return out;
}

// T3 Code's agent tasks, worded for a pull request reached through `gh`.
const PROMPTS = {
  review: (pr) => `Do a code review of pull request #${pr.number} (${pr.url}): ${pr.title}. Read the diff (\`gh pr diff ${pr.url}\`), the description and the existing review threads. Look for correctness bugs, security problems, missing tests, risky migrations and unclear code. Report findings ranked by severity, each with file:line and a concrete fix. Do not change code and do not post anything on GitHub unless I ask.`,
  describe: (pr) => `Write the description of pull request #${pr.number} (${pr.url}): ${pr.title}. Read the diff (\`gh pr diff ${pr.url}\`), the commits (\`gh pr view ${pr.url} --json commits\`) and the current body. Draft: a one-paragraph summary, what changed and why (bullets), how to test, and risks or follow-ups. Keep any template sections the repository uses. Show me the draft first; once I approve, update it with \`gh pr edit ${pr.url} --body-file <file>\`.`,
  explain: (pr) => `Explain pull request #${pr.number} (${pr.url}). Read the diff (\`gh pr diff ${pr.url}\`) and walk through its purpose, the changes, the risks, and what I should read closely before approving. Do not change any code.`,
  feedback: (pr) => `Address the actionable feedback and failing checks on pull request #${pr.number} (${pr.url}). Fetch the latest review threads and check results with \`gh\`, skip resolved feedback, and verify each finding before changing code. First confirm this checkout is on ${pr.headRefName}; if it isn't, prepare the branch in its own worktree. Keep the fixes focused and run the relevant checks.`,
  conflicts: (pr) => `Resolve the conflicts of pull request #${pr.number} (${pr.url}) with its base branch ${pr.baseRefName}. First confirm this checkout is on ${pr.headRefName}; if it isn't, prepare the branch in its own worktree. Bring it up to date using this repository's convention, preserve the intent of both sides, and run the relevant checks before pushing.`,
};
const TASK_NAMES = { review: "Review", describe: "Describe", explain: "Explain", feedback: "Feedback", conflicts: "Conflicts" };

/** A text-only action, as Spend draws choices that should not compete with the numbers. */
// A label in its own color, as GitHub draws it.
function labelChip(l, c, small = false) {
  const color = labelColor(l.color) ?? c.dim;
  return h_flex().h(small ? 20 : 22).px(small ? 7 : 8).gap(5).items_center().rounded(6).bg(color + "26")
    .child(div().size(6).rounded_full().bg(color))
    .child(div().max_w(small ? 140 : 160).truncate().text_size(small ? 11 : 11.5).text_color(c.text).child(l.name));
}
const visible = (list) => (list ?? []).filter((x) => !x.isMinimized);

function quietLink(id, label, onClick, c, options = {}) {
  const disabled = Boolean(options.disabled);
  return Button.new(id).h(24).items_center().cursor_pointer()
    .disabled(disabled)
    .accessibility_label(options.label ?? label)
    .when(!disabled, (el) => el.hover((s) => s.opacity(0.7)))
    .on_click((_e, cx) => { if (!disabled) onClick(cx); })
    .child(div().text_size(options.size ?? 12).text_color(disabled ? c.border : options.color ?? c.muted).child(label));
}

export class PullRequest {
  init(cx) {
    this.pr = null; this.threads = []; this.diffs = null; this.openFile = null;
    this.expanded = { checks: false, files: false, body: false, comments: false }; this.width = 368;
    this.openPrs = []; this.selected = null; // a pull request's URL; null: the branch's own, else the newest
    this.fallback = false; // shown: the newest, as the branch has none
    this.listing = false; // the page of open ones instead of the one shown
    this.picker = null; this.candidates = null; this.query = "";
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.refresh(cx);
    // Every minute while shown, every 20 s while a check runs; never under an open picker.
    cx.timer.every(20000, (cx) => {
      if (this.picker || this.accountOpen) return;
      const pending = this.checks().some((ch) => ch.state === "pending");
      if (pending || Date.now() - (this.loadedAt ?? 0) > cfg().pr.refreshSeconds * 1000 - 2000) this.refresh(cx);
    });
  }

  checks() {
    const seen = new Set();
    return (this.pr?.statusCheckRollup ?? []).map(checkOf).filter((ch) => !seen.has(ch.name) && seen.add(ch.name));
  }

  reload(cx) { this.loadedAt = 0; this.refresh(cx); }
  gh(args) { return ghAs(this.account ?? "", args, { cwd: this.root ?? this.cwd, on: this.on }); }
  repo() { const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(this.pr?.url ?? ""); return m ? { o: m[1], r: m[2] } : null; }
  // Whether a pull request (its URL) belongs to the focused pane's repository.
  local(url) {
    if (url && url === this.branchUrl) return true; // the branch's own, even from a fork's checkout
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url ?? "");
    return Boolean(m && this.home && m[1].toLowerCase() === this.home.toLowerCase());
  }

  refresh(cx) {
    if (!isShown(this.id)) { this.stale = true; return; }
    this.stale = false;
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.branch = null; this.pr = null; this.threads = []; this.diffs = null;
      this.openFile = null; this.error = null; this.note = null; this.none = false; this.armed = null; this.picker = null;
      this.openPrs = []; this.selected = null; this.home = null; this.branchUrl = null; this.outside = false;
      this.fallback = false; this.listing = false;
    }
    if (!cwd) return;
    this.cwd = cwd; this.on = on;
    this.loading = true;
    const want = this.selected;
    cx.spawn(async (cx) => {
      let list = null;
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        // Not a repository is a place, not a failure: a quiet placeholder, no retry.
        if (top.code !== 0) { this.outside = true; this.error = null; this.none = false; this.pr = null; this.openPrs = []; return; }
        this.outside = false;
        this.root = top.stdout.trim();
        const [branch, remote] = await Promise.all([
          exec("git", ["branch", "--show-current"], { cwd: this.root, on }),
          exec("git", ["remote", "get-url", "origin"], { cwd: this.root, on }).catch(() => null),
        ]);
        this.branch = branch.stdout.trim() || null;
        this.home = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(remote?.stdout ?? "")?.[1] ?? null;
        const who = await ghAccount(this.root, on);
        if (key() !== context) return;
        this.account = who.account; this.ghRepo = who.repo; this.pinned = who.pinned;
        this.logins = await ghLogins(on);
        // The repository's open ones, read alongside the one shown.
        list = this.gh(["pr", "list", "--state", "open", "--limit", "100", "--json", OPEN]).catch(() => null);
        let view;
        try { view = await this.gh(["pr", "view", ...(want ? [want] : []), "--json", FIELDS]); }
        catch { this.error = { title: "The GitHub CLI is not installed.", detail: "Install gh and run `gh auth login`." }; this.pr = null; return; }
        // A click picked another one while this read was out: drop it, the finally reads again.
        if (key() !== context || this.selected !== want) return;
        const open = await list;
        if (open?.code === 0 && key() === context) {
          try { this.openPrs = JSON.parse(open.stdout).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)); } catch {}
        }
        // The branch has none: the newest open one stands in, the branch offers to create its own.
        let fallback = false;
        if (view.code !== 0 && !want && NO_PR.test(view.stderr || view.stdout) && this.openPrs.length) {
          view = await this.gh(["pr", "view", this.openPrs[0].url, "--json", FIELDS]).catch(() => ({ code: 1, stdout: "", stderr: "GitHub could not be read." }));
          if (key() !== context || this.selected !== want) return;
          fallback = true;
        }
        if (view.code !== 0) {
          const why = (view.stderr || view.stdout).trim();
          if (NO_PR.test(why)) { this.none = true; this.pr = null; this.error = null; }
          else if (NOT_FOUND.test(why) && this.ghRepo) {
            if (!this.pinned) forgetGhAccount(this.root, on, this.ghRepo);
            this.error = { title: "GitHub could not be read.", detail: noAccess(this.ghRepo, this.account) }; this.pr = null;
          }
          else { this.error = { title: "GitHub could not be read.", detail: why.split("\n")[0] }; this.pr = null; }
          return;
        }
        const pr = JSON.parse(view.stdout);
        if (this.pr?.url !== pr.url) { this.diffs = null; this.openFile = null; this.expanded.body = false; }
        this.pr = pr; this.none = false; this.error = null; this.fallback = fallback;
        if (!want) this.branchUrl = fallback ? null : pr.url;
        if (!this.home && !want) this.home = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1] ?? null;
        const repo = this.repo();
        if (repo) {
          const q = await this.gh(["api", "graphql", "-f", `query=${THREADS}`, "-F", `o=${repo.o}`, "-F", `r=${repo.r}`, "-F", `n=${pr.number}`]).catch(() => null);
          if (q?.code === 0 && key() === context) {
            const nodes = JSON.parse(q.stdout)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
            this.threads = nodes.filter((n) => !n.isResolved).map((n) => {
              const first = n.comments?.nodes?.[0];
              return { path: n.path, line: n.line, outdated: n.isOutdated, author: first?.author?.login ?? "", body: (first?.body ?? "").replace(/\s+/g, " ").trim(), url: first?.url, replies: Math.max(0, (n.comments?.totalCount ?? 1) - 1) };
            });
          }
        }
        if (!this.viewer) {
          const me = await this.gh(["api", "user", "--jq", ".login"]).catch(() => null);
          if (me?.code === 0) this.viewer = me.stdout.trim();
        }
      } catch (e) { if (key() === context) this.error = { title: "GitHub could not be read.", detail: String(e?.message ?? e) }; }
      finally {
        await list; // never left running past the read it belongs to
        this.loading = false; this.loadedAt = Date.now(); cx.notify();
        if (this.selected !== want && key() === context) this.refresh(cx);
      }
    });
  }

  // Shows another open pull request (by its URL); the branch's own goes back to
  // following the branch.
  choose(p, cx) {
    this.listing = false;
    if (this.pr?.url === p.url) { cx.notify(); return; }
    this.selected = p.url === this.branchUrl ? null : p.url; this.pr = null; this.threads = []; this.diffs = null; this.openFile = null;
    this.none = false; this.error = null; this.note = null; this.armed = null; this.picker = null;
    this.loadedAt = 0; this.refresh(cx); cx.notify();
  }

  // ---- actions ----

  act(label, args, cx) {
    if (this.busy) return;
    this.busy = label; this.note = null; this.armed = null;
    cx.spawn(async (cx) => {
      try {
        const r = await this.gh(args);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
      } catch (e) { this.note = `${label} failed: ${String(e?.message ?? e)}`; }
      finally { this.busy = null; this.loadedAt = 0; cx.notify(); this.refresh(cx); }
    });
    cx.notify();
  }

  // The second press within 4 s merges, with the first method the repository allows.
  merge(cx) {
    if (this.armed !== "merge" || Date.now() - this.armedAt > 4000) { this.armed = "merge"; this.armedAt = Date.now(); cx.notify(); return; }
    const pr = this.pr;
    this.busy = "Merge"; this.armed = null; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const { o, r: name } = this.repo();
        const repo = await this.gh(["repo", "view", `${o}/${name}`, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"]);
        const allowed = repo.code === 0 ? JSON.parse(repo.stdout) : {};
        const want = cfg().pr.mergeMethod;
        const auto = allowed.squashMergeAllowed !== false ? "--squash" : allowed.mergeCommitAllowed ? "--merge" : "--rebase";
        const method = want === "squash" || want === "merge" || want === "rebase" ? `--${want}` : auto;
        const r = await this.gh(["pr", "merge", pr.url, method]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
        notify({ title: `Merged #${pr.number}`, body: pr.title, level: "success" });
      } catch (e) { this.note = `Merge failed: ${String(e?.message ?? e)}`; }
      finally { this.busy = null; this.loadedAt = 0; cx.notify(); this.refresh(cx); }
    });
    cx.notify();
  }

  createPr(cx) {
    if (this.busy) return;
    this.busy = "Create"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const up = await exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: this.root, on: this.on });
        if (up.code !== 0) throw new Error(`push ${this.branch ?? "the branch"} first; it has no upstream`);
        const r = await this.gh(["pr", "create", "--web"]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
      } catch (e) { this.note = `Could not create it: ${String(e?.message ?? e)}`; }
      finally { this.busy = null; cx.notify(); }
    });
    cx.notify();
  }

  agentTask(task, pr = this.pr) {
    const vars = { number: pr.number, url: pr.url, title: pr.title, head: pr.headRefName, base: pr.baseRefName };
    startAgent({ name: `#${pr.number} ${TASK_NAMES[task]}`, space: location().space, folder: this.root ?? this.cwd, on: this.on, task: prompt(task, vars, PROMPTS[task](pr)) });
  }

  // ---- T3 Code's candidate pickers: assignees, reviewers, labels ----

  openPicker(kind, open, cx) {
    this.picker = open ? kind : null;
    this.query = ""; this.search.set_value("");
    this.candidates = null; this.pickerError = null; this.truncated = false;
    if (open) {
      this.search.focus();
      const repo = this.repo(), context = this.context;
      cx.spawn(async (cx) => {
        try {
          const q = kind === "labels" ? LABELS : PEOPLE;
          const r = await this.gh(["api", "graphql", "-f", `query=${q}`, "-F", `o=${repo.o}`, "-F", `r=${repo.r}`]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
          if (this.context !== context || this.picker !== kind) return;
          const data = JSON.parse(r.stdout).data;
          if (data?.viewer?.login) this.viewer = data.viewer.login;
          const list = kind === "labels" ? data.repository.labels : data.repository.assignableUsers;
          this.truncated = Boolean(list.pageInfo?.hasNextPage);
          this.candidates = list.nodes;
        } catch (e) { this.pickerError = String(e?.message ?? e); }
        cx.notify();
      });
    }
    cx.notify();
  }

  applied(kind) {
    const pr = this.pr;
    if (kind === "labels") return new Set((pr.labels ?? []).map((l) => l.name));
    if (kind === "assignees") return new Set((pr.assignees ?? []).map((a) => a.login));
    return new Set((pr.reviewRequests ?? []).map((r) => r.login).filter(Boolean));
  }

  // Applies or takes back one candidate through the REST API; the picker stays open, as in T3 Code.
  toggle(kind, name, on, cx) {
    if (this.pending) return;
    const { o, r } = this.repo(), n = this.pr.number;
    const call = {
      labels: on ? ["-X", "DELETE", `repos/${o}/${r}/issues/${n}/labels/${encodeURIComponent(name)}`] : ["-X", "POST", `repos/${o}/${r}/issues/${n}/labels`, "-f", `labels[]=${name}`],
      assignees: ["-X", on ? "DELETE" : "POST", `repos/${o}/${r}/issues/${n}/assignees`, "-f", `assignees[]=${name}`],
      reviewers: ["-X", on ? "DELETE" : "POST", `repos/${o}/${r}/pulls/${n}/requested_reviewers`, "-f", `reviewers[]=${name}`],
    }[kind];
    const done = { assignees: on ? `Unassigned ${name}` : `Assigned ${name}`, reviewers: on ? `Review request to ${name} taken back` : `Review requested from ${name}` }[kind];
    const failed = { labels: on ? `Could not take ${name} off` : `Could not put ${name} on`, assignees: on ? `Could not unassign ${name}` : `Could not assign ${name}`, reviewers: on ? `Could not take back the request to ${name}` : `Could not ask ${name} for a review` }[kind];
    const why = { labels: "Changing labels needs triage access on this repository.", assignees: "Assigning needs triage access on this repository.", reviewers: "Asking for a review needs write access on this repository." }[kind];
    this.pending = name;
    cx.spawn(async (cx) => {
      try {
        const res = await this.gh(["api", ...call, "--silent"]);
        if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split("\n")[0]);
        // Reflect it at once; the reread below confirms it.
        const pr = this.pr;
        if (kind === "labels") pr.labels = on ? pr.labels.filter((l) => l.name !== name) : [...pr.labels, (this.candidates ?? []).find((l) => l.name === name) ?? { name }];
        if (kind === "assignees") pr.assignees = on ? pr.assignees.filter((a) => a.login !== name) : [...pr.assignees, { login: name }];
        if (kind === "reviewers") pr.reviewRequests = on ? pr.reviewRequests.filter((x) => x.login !== name) : [...pr.reviewRequests, { login: name }];
        if (done) notify({ title: done, level: "success" });
      } catch (e) { notify({ title: failed, body: `${String(e?.message ?? e)} ${why}`, level: "error" }); }
      finally { this.pending = null; cx.notify(); this.loadedAt = 0; this.refresh(cx); }
    });
    cx.notify();
  }

  pickerFor(kind, c) {
    const id = `pr-pick-${kind}`;
    const label = { labels: "Change labels", assignees: "Assign people", reviewers: "Request a review" }[kind];
    const trigger = Button.new(`${id}-trigger`).size(22).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .accessibility_label(label).tooltip(label)
      .hover((s) => s.bg(c.subtle))
      .child(svg(`${ICON}${kind === "labels" ? "tag" : "user-plus"}.svg`).size(13).text_color(c.muted));
    const popover = Popover.new(id).trigger(trigger).anchor("top_right")
      .open(this.picker === kind)
      .on_open_change((open, cx) => this.openPicker(kind, open, cx));
    if (this.picker !== kind) return popover;
    const applied = this.applied(kind), q = this.query.toLowerCase();
    const author = this.pr.author?.login;
    const all = (this.candidates ?? []).filter((x) => kind !== "reviewers" || x.login !== author);
    const shown = all.filter((x) => !q || [x.name, x.login, x.description].some((v) => String(v ?? "").toLowerCase().includes(q)));
    const empty = { labels: "This repository has no labels.", assignees: "Nobody has access to this repository.", reviewers: "Nobody else has access to this repository." }[kind];
    const noMatch = kind === "labels" ? "No label matches that." : "Nobody with access matches that.";
    const list = v_flex().gap(1)
      .when(!this.candidates && !this.pickerError, (el) => el.child(v_flex().loop("opacity", { from: 0.35, to: 0.8, period: 1800 })
        .children([90, 120, 70, 104].map((w, i) => h_flex().id(`${id}-ghost-${i}`).px(8).py(7).gap(G.sm).child(div().size(8).rounded_full().bg(c.border)).child(div().w(w).h(9).rounded(3).bg(c.border))))))
      .when(Boolean(this.pickerError), (el) => el.child(div().p(8).text_size(11.5).text_color(c.dim).child(`${kind === "labels" ? "The labels" : "The people with access"} could not be read. ${this.pickerError}`)))
      .when(Boolean(this.candidates) && shown.length === 0, (el) => el.child(div().p(8).text_size(11.5).text_color(c.dim).child(q ? noMatch : empty)))
      .children(shown.map((x, i) => {
        const name = kind === "labels" ? x.name : x.login, on = applied.has(name), color = kind === "labels" ? labelColor(x.color) : null;
        return Button.new(`${id}-${i}`).w_full().px(8).py(5).gap(G.sm).items_center().rounded(6).cursor_pointer()
          .disabled(Boolean(this.pending))
          .hover((s) => s.bg(c.subtle))
          .accessibility_label(name)
          .on_click((_e, cx) => this.toggle(kind, name, on, cx))
          .when(kind === "labels", (el) => el.child(div().size(8).flex_none().rounded_full().bg(color ?? c.dim)))
          .child(h_flex().flex_1().min_w(0).gap(4)
            .child(div().flex_none().text_size(12).text_color(c.text).child(name))
            .when(kind !== "labels" && Boolean(x.name) && x.name !== x.login, (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(c.dim).child(x.name)))
            .when(kind === "labels" && Boolean(x.description), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(c.dim).child(`· ${x.description}`))))
          .child(div().w(14).flex_none().text_size(12).text_color(c.text).child(this.pending === name ? "…" : on ? "✓" : ""));
      }))
      .when(this.truncated, (el) => el.child(div().px(8).py(6).text_size(11).text_color(c.dim)
        .child(kind === "labels" ? "This repository has more labels than are listed here. Apply the rest on GitHub." : "This repository has more people with access than are listed here. Ask for the rest on GitHub.")));
    // The list sizes to its rows up to 290 px, then scrolls; a flex share would collapse it to nothing.
    return popover.content(v_flex().w(288).p(G.xs).gap(G.xs).rounded(8).bg(c.popover).border_1().border_color(c.border)
      .child(div().h(30).flex_none().px(8).flex().items_center().rounded(6).border_1().border_color(c.border)
        .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(c.text)))
      .child(div().id(`${id}-list`).w_full().max_h(290).overflow_y_scrollbar().child(list)));
  }

  // ---- drawing, as Spend draws ----

  // The repository's open pull requests, by anyone: yours first, then the newest.
  openList() {
    const me = this.viewer;
    return [...(this.openPrs ?? [])].sort((a, b) => Number(b.author?.login === me) - Number(a.author?.login === me));
  }

  // One open pull request's state, in a word and a color, from what the list reads.
  rowState(p, c) {
    const seen = new Set();
    const checks = (p.statusCheckRollup ?? []).map(checkOf).filter((ch) => !seen.has(ch.name) && seen.add(ch.name));
    const failing = checks.filter((x) => x.state === "fail").length, running = checks.filter((x) => x.state === "pending").length;
    if (p.isDraft) return { text: "Draft", color: c.dim };
    if (failing) return { text: `${failing} check${failing > 1 ? "s" : ""} failing`, color: c.red };
    if (p.reviewDecision === "CHANGES_REQUESTED") return { text: "Changes requested", color: c.red };
    if (running) return { text: `${running} check${running > 1 ? "s" : ""} running`, color: c.yellow };
    if (p.reviewDecision === "APPROVED") return { text: "Approved", color: c.green };
    if (p.reviewDecision === "REVIEW_REQUIRED") return { text: "Waiting for a review", color: c.yellow };
    if (checks.length) return { text: "Checks passed", color: c.green };
    return { text: "Open", color: c.dim };
  }

  // Whether there is anything to switch to: hidden when the only one is the one shown.
  canSwitch() {
    const list = this.openPrs ?? [];
    const create = (this.fallback || this.none) && Boolean(this.branch);
    return list.length > 0 && !(list.length === 1 && list[0].url === this.pr?.url && !create);
  }

  // The header's pill: "N open" turns to the page of open ones; there, "Back to #n" returns.
  switchPill(c) {
    const back = this.listing && this.pr;
    const label = this.listing ? (back ? `Back to #${this.pr.number}` : "Back") : `${this.openPrs.length} open`;
    return Button.new("pr-switch").h(26).pl(10).pr(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
      .border_1().border_color(this.listing ? c.muted : c.border)
      .accessibility_label(this.listing ? label : `${this.openPrs.length} open pull requests`)
      .tooltip(this.listing ? "Back to the one shown" : "Every open pull request")
      .hover((s) => s.bg(c.subtle))
      .on_click((_e, cx) => { this.listing = !this.listing; cx.notify(); })
      .child(div().text_size(12).text_color(c.text).child(label))
      .when(!this.listing, (el) => el.child(svg(`${ICON}chevron-right.svg`).size(12).text_color(c.muted)));
  }

  // The page of open ones, grouped as this branch, yours and others. Each row
  // reads as the hero does in small: the whole title, who and when, then its
  // state in its color and its size; the shown one is selected and says so.
  openPage(c) {
    const list = this.openList(), shown = this.pr?.url, me = this.viewer;
    const here = (p) => p.url === this.branchUrl || p.headRefName === this.branch;
    const mine = (p) => Boolean(me) && p.author?.login === me;
    const groups = [
      ["This branch", list.filter(here)],
      ["Yours", list.filter((p) => !here(p) && mine(p))],
      [me ? "Others" : "Open", list.filter((p) => !here(p) && !mine(p))],
    ].filter(([, rows]) => rows.length);
    const create = (this.fallback || this.none) && Boolean(this.branch);
    let n = 0;
    const row = (p) => {
      const on = p.url === shown, state = this.rowState(p, c), i = n++;
      const talk = visible(p.comments).length;
      const meta = [`#${p.number}`, mine(p) ? "you" : p.author?.login, `updated ${ago(p.updatedAt)}`, talk ? `${talk} comment${talk > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ");
      return Button.new(`pr-open-${i}`).w_full().px(G.md).py(10).rounded(6).cursor_pointer()
        .selected(on)
        .when(on, (el) => el.bg(c.selected))
        .when(!on, (el) => el.hover((s) => s.bg(c.subtle)))
        .accessibility_label(`#${p.number} ${p.title}${on ? ", shown" : ""}`)
        .on_click((_e, cx) => this.choose(p, cx))
        .child(v_flex().w_full().min_w(0).gap(4)
          .child(h_flex().w_full().items_start().gap(G.md)
            .child(div().flex_1().min_w(0).text_size(14).line_height(1.35).text_color(c.text).when(on, (e) => e.font_medium()).child(p.title))
            .when(on, (el) => el.child(div().flex_none().pt(2).text_size(11).text_color(c.text).child("Shown")))
            .when(cfg().pr.rowActions, (el) => el.child(this.iconButton(`pr-open-web-${i}`, "external", "Open in browser", (cx) => { cx.stop_propagation(); openUrl(p.url); }, c))))
          .child(div().w_full().truncate().text_size(11.5).text_color(c.dim).child(meta))
          .when(true, (el) => {
            const jira = jiraChips(`pr-open-${i}`, [p.title, p.headRefName], c, { loose: true });
            return jira.length || (p.labels ?? []).length ? el.child(h_flex().w_full().flex_wrap().gap(6).children(jira).children((p.labels ?? []).slice(0, 5).map((l) => labelChip(l, c, true)))) : el;
          })
          .child(h_flex().w_full().gap(G.sm).items_center()
            .child(div().size(6).flex_none().rounded_full().bg(state.color))
            .child(div().text_size(12).text_color(state.color === c.dim ? c.muted : state.color).child(state.text))
            .when(p.additions !== undefined, (el) => el.child(div().text_size(12).text_color(c.dim).child(`+${p.additions} −${p.deletions}`)))
            .child(div().flex_1())
            .when(cfg().pr.rowActions && cfg().pr.tasks.review, (el) => el.child(quietLink(`pr-row-review-${i}`, "Review", () => this.agentTask("review", p), c, { size: 11.5 })))
            .when(cfg().pr.rowActions && cfg().pr.tasks.describe, (el) => el.child(quietLink(`pr-row-describe-${i}`, "Describe", () => this.agentTask("describe", p), c, { size: 11.5 })))));
    };
    return v_flex().w_full().gap(G.xl)
      .children(groups.map(([title, rows]) => v_flex().w_full().gap(2)
        .child(this.section(c, title, String(rows.length)))
        .children(rows.map(row))))
      .when(create, (el) => el.child(v_flex().w_full().gap(G.xs)
        .child(div().text_size(12).text_color(c.dim).child(`${this.branch} has no pull request yet.`))
        .child(h_flex().child(quietLink("pr-create-list", this.busy === "Create" ? "Opening GitHub…" : `Create one for ${this.branch}`, (cx) => this.createPr(cx), c, { size: 13, color: c.text, disabled: Boolean(this.busy) })))))
      .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(c.red).child(this.note)));
  }

  iconButton(id, icon, tip, onClick, c, spin) {
    const glyph = svg(`${ICON}${icon}.svg`).size(15).text_color(spin ? c.text : c.muted);
    return Button.new(id).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .accessibility_label(tip).tooltip(tip)
      .hover((s) => s.bg(c.subtle))
      .on_click((_e, cx) => onClick(cx))
      .child(spin ? glyph.spin(900) : glyph);
  }

  header(c, narrow) {
    const pr = this.pr, pill = this.listing || this.canSwitch();
    return h_flex().w_full().items_center().justify_between().gap(G.md)
      .child(div().truncate().text_size(narrow ? 17 : 20).text_color(c.text).child(this.listing ? "Open pull requests" : "Pull request"))
      .child(h_flex().gap(G.xs).items_center().flex_none()
        .when(pill, (el) => el.child(this.switchPill(c)))
        .when(Boolean(this.root) && !this.outside, (el) => el.child(accountPicker(this, c, "pr")))
        .child(this.iconButton("pr-refresh", "refresh", this.loadedAt ? `Refresh · updated ${clock(this.loadedAt)}` : "Refresh", (cx) => { this.loadedAt = 0; this.refresh(cx); }, c, this.loading))
        .when(Boolean(pr) && !this.listing, (el) => el.child(this.iconButton("pr-copy", this.copied === pr.url ? "check" : "copy", this.copied === pr.url ? "Copied" : "Copy link", (cx) => this.copyUrl(pr.url, cx), c)))
        .when(Boolean(pr), (el) => el.child(this.iconButton("pr-web", "open-with", "Open on GitHub", () => openUrl(pr.url), c))));
  }

  // The pull request's address to the clipboard; the icon turns to a check for 1.5 s.
  copyUrl(url, cx) {
    cx.write_to_clipboard(url);
    this.copied = url; cx.notify();
    const at = this.copiedAt = Date.now();
    cx.timer.after(1500, (cx) => { if (this.copiedAt === at) { this.copied = null; cx.notify(); } });
  }

  skeleton(c, narrow) {
    const block = (w, h, r = 3) => div().w(w).h(h).flex_none().rounded(r).bg(c.border);
    const row = (i) => h_flex().w_full().items_center().gap(G.md).py(9).child(block([120, 96, 140, 84, 110][i % 5], 9)).child(div().flex_1()).child(block(36, 11));
    return v_flex().w_full().gap(narrow ? 36 : 48).loop("opacity", { from: 0.35, to: 0.8, period: 1800 })
      .child(v_flex().gap(G.md).child(block(140, 12)).child(block(narrow ? 240 : 420, narrow ? 22 : 28, 4)).child(block(180, 22, 4)).child(block(150, 11))
        .child(h_flex().gap(narrow ? G.xl : 48).pt(G.md).children([30, 46, 40, 30].map((w) => block(w, narrow ? 18 : 22, 4)))))
      .child(v_flex().gap(G.sm).children([0, 1, 2].map((i) => h_flex().gap(G.md).child(block(70, 10)).child(block([90, 120, 80][i], 10)))))
      .child(v_flex().w_full().child(h_flex().pb(G.sm).child(block(70, 12))).children([0, 1, 2, 3, 4].map(row)));
  }

  waiting(c, title, detail, action) {
    return v_flex().w_full().gap(G.sm)
      .child(div().text_size(15).text_color(this.error ? c.red : c.muted).child(title))
      .when(Boolean(detail), (el) => el.child(div().text_size(12).text_color(c.dim).child(detail)))
      .when(Boolean(action), (el) => el.child(h_flex().pt(G.xs).child(action)));
  }

  section(c, title, note) {
    return h_flex().w_full().items_end().justify_between().pb(G.sm)
      .child(div().text_size(15).text_color(c.text).child(title))
      .child(div().text_size(12).text_color(c.dim).child(note ?? ""));
  }

  verdict(c) {
    const pr = this.pr, checks = this.checks();
    const failing = checks.filter((x) => x.state === "fail").length, running = checks.filter((x) => x.state === "pending").length;
    const conflicting = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY", ms = pr.mergeStateStatus;
    if (pr.state === "MERGED") return { text: "Merged", color: c.violet };
    if (pr.state === "CLOSED") return { text: "Closed without merging", color: c.red };
    if (pr.isDraft) return { text: "Draft, not ready for review", color: c.dim };
    if (conflicting) return { text: `Conflicts with ${pr.baseRefName}`, color: c.red };
    if (failing) return { text: `${failing} check${failing > 1 ? "s" : ""} failing`, color: c.red };
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: "Changes requested", color: c.red };
    if (running) return { text: `${running} check${running > 1 ? "s" : ""} running`, color: c.yellow };
    if (ms === "BLOCKED") return { text: pr.reviewDecision === "REVIEW_REQUIRED" ? "Waiting for a review" : "Blocked by branch rules", color: c.yellow };
    if (ms === "BEHIND") return { text: `Behind ${pr.baseRefName}`, color: c.yellow };
    if (ms === "CLEAN" || ms === "HAS_HOOKS" || ms === "UNSTABLE") return { text: "Ready to merge", color: c.green };
    return { text: "Checking whether it can merge…", color: c.dim };
  }

  hero(c, narrow) {
    const pr = this.pr, v = this.verdict(c), open = pr.state === "OPEN";
    const conflicting = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY", ms = pr.mergeStateStatus;
    const canMerge = open && !pr.isDraft && !conflicting && ms !== "BLOCKED" && ms !== "DRAFT";
    const arming = this.armed === "merge" && Date.now() - this.armedAt <= 4000;
    const checks = this.checks();
    const stats = [
      { value: String(pr.changedFiles), unit: pr.changedFiles === 1 ? "file" : "files" },
      { value: `+${pr.additions}`, unit: "added" },
      { value: `−${pr.deletions}`, unit: "removed" },
      { value: String(this.threads.length), unit: this.threads.length === 1 ? "thread" : "threads" },
      { value: String(visible(pr.comments).length), unit: visible(pr.comments).length === 1 ? "comment" : "comments" },
      { value: String(checks.length), unit: checks.length === 1 ? "check" : "checks" },
    ];
    const primary = Button.new("pr-merge").h(30).px(14).flex_none().items_center().rounded(6)
      .disabled(!canMerge || Boolean(this.busy))
      .bg(canMerge ? (arming ? c.red : c.primary) : c.subtle)
      .when(canMerge && !this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_click((_e, cx) => { if (canMerge && !this.busy) this.merge(cx); })
      .child(div().text_size(12).font_medium().text_color(canMerge ? (arming ? "#ffffff" : c.primaryText) : c.dim)
        .child(this.busy === "Merge" ? "Merging…" : arming ? "Press again to merge" : "Merge"));
    return v_flex().w_full().gap(G.xl)
      .child(v_flex().gap(G.xs)
        .child(div().text_size(15).text_color(c.muted).child(`${this.local(pr.url) ? "" : `${this.repo()?.o}/${this.repo()?.r} `}#${pr.number} · ${pr.headRefName} → ${pr.baseRefName}`))
        .child(div().w_full().text_size(narrow ? 22 : 28).line_height(1.25).font_light().text_color(c.text).child(pr.title))
        .child(h_flex().pt(G.xs).gap(G.sm).items_center()
          .child(div().size(6).flex_none().rounded_full().bg(v.color).when(v.color === c.yellow, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 2400 })))
          .child(div().text_size(15).text_color(c.text).child(v.text)))
        .child(div().text_size(12).text_color(c.dim).child([pr.author?.login, `updated ${ago(pr.updatedAt)}`, this.fallback && `the newest open; ${this.branch ?? "this branch"} has none`].filter(Boolean).join(" · ")))
        .child(this.tags(c)))
      .child(h_flex().w_full().flex_wrap().gap_x(narrow ? G.xl : 48).gap_y(G.lg)
        .children(stats.map((s) => h_flex().items_end().gap(6)
          .child(div().text_size(narrow ? 22 : 28).line_height(1).font_light().text_color(c.text).child(s.value))
          .child(div().pb(3).text_size(12).text_color(c.dim).child(s.unit)))))
      .when(open, (el) => el.child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.sm).items_center()
        .child(primary)
        .child(pr.isDraft
          ? quietLink("pr-ready", this.busy === "Ready" ? "Marking ready…" : "Ready for review", (cx) => this.act("Ready", ["pr", "ready", pr.url], cx), c, { disabled: Boolean(this.busy) })
          : quietLink("pr-draft", "Back to draft", (cx) => this.act("Draft", ["pr", "ready", pr.url, "--undo"], cx), c, { disabled: Boolean(this.busy) }))
        .child(quietLink("pr-close", "Close", (cx) => this.act("Close", ["pr", "close", pr.url], cx), c, { disabled: Boolean(this.busy) }))))
      .when(pr.state === "CLOSED", (el) => el.child(h_flex().child(quietLink("pr-reopen", "Reopen", (cx) => this.act("Reopen", ["pr", "reopen", pr.url], cx), c, { disabled: Boolean(this.busy) }))))
      .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(c.red).child(this.note)));
  }

  // Labels (with their picker) and the Jira ticket the title or branch names.
  tags(c) {
    const pr = this.pr, jira = jiraChips("pr", [pr.title, pr.headRefName], c, { loose: true });
    return h_flex().w_full().pt(G.sm).flex_wrap().gap(6).items_center()
      .children(jira)
      .children((pr.labels ?? []).map((l) => labelChip(l, c)))
      .when(!(pr.labels ?? []).length && !jira.length, (el) => el.child(div().text_size(12).text_color(c.dim).child("No labels")))
      .when(pr.state === "OPEN", (el) => el.child(this.pickerFor("labels", c)));
  }

  // The conversation: comments on the pull request itself, the newest last.
  comments(c) {
    const all = visible(this.pr.comments), open = this.expanded.comments;
    const list = open ? all : all.slice(-5);
    return v_flex().w_full()
      .child(this.section(c, "Comments", String(all.length)))
      .when(all.length > list.length, (el) => el.child(h_flex().pb(G.sm).child(quietLink("pr-comments-more", `Show ${all.length - list.length} earlier`, (cx) => { this.expanded.comments = true; cx.notify(); }, c))))
      .children(list.map((m, i) => {
        const body = String(m.body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
        return Button.new(`pr-comment-${i}`).w_full().py(8).cursor_pointer()
          .when(i > 0, (el) => el.border_t(1).border_color(c.border))
          .hover((s) => s.opacity(0.75)).tooltip("Open on GitHub")
          .on_click(() => { if (m.url) openUrl(m.url); })
          .child(v_flex().w_full().gap(3)
            .child(h_flex().gap(G.sm).items_center()
              .child(div().text_size(12).text_color(c.text).child(m.author?.login === this.viewer ? "you" : m.author?.login ?? "someone"))
              .child(div().text_size(11).text_color(c.dim).child(ago(m.createdAt))))
            .child(div().w_full().text_size(13).line_height(1.45).text_color(c.muted).child(body.length > 280 ? body.slice(0, 280) + "…" : body || "(empty)"))
            .child(h_flex().flex_wrap().gap(6).children(jiraChips(`pr-comment-${i}`, body, c))));
      }));
  }

  // The description, as GitHub renders it: Markdown, folded to a few lines when long.
  description(c) {
    const text = cleanBody(this.pr.body), long = longBody(text), open = this.expanded.body;
    const toggle = (cx) => { this.expanded.body = !open; cx.notify(); };
    return v_flex().w_full()
      .child(this.section(c, "Description"))
      .child(text
        ? div().id("pr-body").w_full().text_size(13).line_height(1.5).text_color(c.text)
          .when(long && !open, (el) => el.max_h(BODY_FOLD).overflow_hidden())
          .child(TextView.markdown("pr-body-md", linkJira(text)).selectable(true).on_link_click((url) => openUrl(url)))
        : div().text_size(13).text_color(c.dim).child("No description."))
      .when(Boolean(text) && long, (el) => el.child(h_flex().pt(G.sm).child(quietLink("pr-body-more", open ? "Show less" : "Show all", toggle, c))));
  }

  // Who and what it carries, in T3 Code's meta rows: a quiet label column, the values, a picker.
  people(c) {
    const pr = this.pr, open = pr.state === "OPEN";
    const metaRow = (label, values, picker, extra) => h_flex().w_full().min_h(28).gap(G.md).items_center()
      .child(div().w(76).flex_none().text_size(12).text_color(c.dim).child(label))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6).items_center()
        .children(values.length ? values : [div().text_size(13).text_color(c.dim).child("None")])
        .when(Boolean(extra), (el) => el.child(extra)))
      .when(Boolean(picker), (el) => el.child(picker));
    const person = (login, sub, color) => h_flex().gap(4).items_center()
      .when(Boolean(color), (el) => el.child(div().size(6).rounded_full().bg(color)))
      .child(div().text_size(13).text_color(c.text).child(login))
      .when(Boolean(sub), (el) => el.child(div().text_size(11).text_color(c.dim).child(sub)));
    const assignees = (pr.assignees ?? []).map((a) => person(a.login));
    const mine = this.viewer && (pr.assignees ?? []).some((a) => a.login === this.viewer);
    // Reviewers: who reviewed, with the outcome, then who is still asked.
    const outcome = { APPROVED: ["approved", c.green], CHANGES_REQUESTED: ["changes", c.red], COMMENTED: ["commented", null], DISMISSED: ["dismissed", null] };
    const reviewed = (pr.latestReviews ?? []).filter((r) => r.author?.login).map((r) => person(r.author.login, outcome[r.state]?.[0] ?? String(r.state).toLowerCase(), outcome[r.state]?.[1]));
    const asked = (pr.reviewRequests ?? []).map((r) => person(r.login ?? r.name ?? r.slug, r.login ? "requested" : "team · requested", c.yellow));
    const decision = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" }[pr.reviewDecision] ?? "";
    return v_flex().w_full()
      .child(this.section(c, "People", decision))
      .child(v_flex().w_full().gap(G.xs)
        .child(metaRow("Assignees", assignees, open ? this.pickerFor("assignees", c) : null,
          open && this.viewer && !mine ? quietLink("pr-assign-me", "Assign to me", (cx) => this.toggle("assignees", this.viewer, false, cx), c, { disabled: Boolean(this.pending) }) : null))
        .child(metaRow("Reviewers", [...reviewed, ...asked], open ? this.pickerFor("reviewers", c) : null)));
  }

  checksList(c) {
    const checks = this.checks();
    const failing = checks.filter((x) => x.state === "fail"), running = checks.filter((x) => x.state === "pending"), passed = checks.length - failing.length - running.length;
    const order = { fail: 0, pending: 1, pass: 2 };
    const sorted = [...checks].sort((a, b) => order[a.state] - order[b.state]);
    const open = this.expanded.checks, shown = open ? sorted : sorted.slice(0, 5);
    const note = [failing.length && `${failing.length} failing`, running.length && `${running.length} running`, passed && `${passed} passed`].filter(Boolean).join(" · ");
    return v_flex().w_full()
      .child(this.section(c, "Checks", note))
      .children(shown.map((ch, i) => Button.new(`pr-check-${i}`).w_full().py(7).cursor_pointer()
        .when(i > 0, (el) => el.border_t(1).border_color(c.border))
        .hover((s) => s.opacity(0.75))
        .on_click(() => { if (ch.url) openUrl(ch.url); })
        .child(h_flex().w_full().items_end().gap(G.md)
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(13).text_color(c.text).child(ch.name))
            .when(Boolean(ch.workflow), (el) => el.child(div().truncate().text_size(11).text_color(c.dim).child(ch.workflow))))
          .child(div().text_size(12).text_color(ch.state === "fail" ? c.red : ch.state === "pending" ? c.yellow : c.dim)
            .child(ch.state === "fail" ? "failed" : ch.state === "pending" ? "running" : ch.skipped ? "skipped" : "passed")))))
      .when(sorted.length > 5, (el) => el.child(h_flex().pt(G.sm).child(quietLink("pr-checks-more", open ? "Show fewer" : `Show ${sorted.length - 5} more`, (cx) => { this.expanded.checks = !open; cx.notify(); }, c))));
  }

  discussion(c) {
    return v_flex().w_full()
      .child(this.section(c, "Unresolved threads", String(this.threads.length)))
      .children(this.threads.map((th, i) => Button.new(`pr-thread-${i}`).w_full().py(8).cursor_pointer()
        .when(i > 0, (el) => el.border_t(1).border_color(c.border))
        .hover((s) => s.opacity(0.75))
        .on_click(() => { if (th.url) openUrl(th.url); })
        .child(v_flex().w_full().gap(3)
          .child(div().w_full().text_size(13).line_height(1.45).text_color(c.text).child(th.body.length > 240 ? th.body.slice(0, 240) + "…" : th.body))
          .child(h_flex().flex_wrap().gap(6).children(jiraChips(`pr-thread-${i}`, th.body, c)))
          .child(h_flex().w_full().flex_wrap().gap_x(G.md)
            .child(div().text_size(11).text_color(c.dim).child(`${th.path}${th.line ? `:${th.line}` : ""}`))
            .child(div().text_size(11).text_color(c.dim).child(th.author))
            .when(th.replies > 0, (el) => el.child(div().text_size(11).text_color(c.dim).child(`${th.replies} repl${th.replies > 1 ? "ies" : "y"}`)))
            .when(th.outdated, (el) => el.child(div().text_size(11).text_color(c.dim).child("outdated")))))));
  }

  agent(c) {
    const pr = this.pr, open = pr.state === "OPEN";
    const conflicting = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
    // Fixing code needs a checkout of its repository; explaining reads it from GitHub.
    const here = this.local(pr.url);
    const tasks = cfg().pr.tasks;
    return v_flex().w_full()
      .child(this.section(c, "Ask your agent", here ? "in a new tab" : "another repository: explain only"))
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.xs)
        .when(tasks.review, (el) => el.child(quietLink("pr-review", "Code review", () => this.agentTask("review"), c, { size: 13, color: c.text })))
        .when(tasks.describe, (el) => el.child(quietLink("pr-describe", "Describe change", () => this.agentTask("describe"), c, { size: 13, color: c.text, disabled: !open || !here })))
        .when(tasks.explain, (el) => el.child(quietLink("pr-explain", "Explain it", () => this.agentTask("explain"), c, { size: 13, color: c.text })))
        .when(tasks.feedback, (el) => el.child(quietLink("pr-feedback", "Address feedback", () => this.agentTask("feedback"), c, { size: 13, color: c.text, disabled: !open || !here })))
        .when(tasks.conflicts, (el) => el.child(quietLink("pr-conflicts", "Resolve conflicts", () => this.agentTask("conflicts"), c, { size: 13, color: c.text, disabled: !(open && conflicting && here) }))));
  }

  diffView(c, path) {
    if (this.diffLoading && !this.diffs) return div().py(6).text_size(11).text_color(c.dim).child("Reading the diff…");
    const lines = this.diffs?.[path];
    if (!lines) return div().py(6).text_size(11).text_color(c.dim).child(this.diffs ? "No text diff for this file." : "");
    return v_flex().w_full().mb(G.sm).rounded(6).border_1().border_color(c.border).overflow_hidden().font_family(c.mono).text_size(11)
      .children(diffRows(lines, { max: MAX_DIFF, width: 400 }).map((r) => r.kind === "@"
        ? div().h(20).px(10).flex_none().truncate().text_color(c.dim).child(r.text)
        : h_flex().h(20).flex_none().gap(8).when(r.kind === "+", (e) => e.bg(c.green + "18")).when(r.kind === "-", (e) => e.bg(c.red + "18"))
          .child(div().w(30).flex_none().text_right().text_color(c.dim).child(r.number === undefined ? "" : String(r.number)))
          .child(div().flex_1().min_w(0).truncate().text_color(c.text).child(r.text))))
      .when(lines.length > MAX_DIFF, (el) => el.child(div().px(10).py(4).text_color(c.dim).child(`The first ${MAX_DIFF} lines; the rest is on GitHub.`)));
  }

  pickFile(path, cx) {
    this.openFile = this.openFile === path ? null : path;
    if (this.openFile && !this.diffs && this.pr) {
      const url = this.pr.url, context = this.context;
      this.diffLoading = true;
      cx.spawn(async (cx) => {
        try {
          const r = await this.gh(["pr", "diff", url, "--color", "never"]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
          if (this.context === context && this.pr?.url === url) this.diffs = splitDiff(r.stdout);
        } catch (e) { this.note = `Could not read the diff: ${String(e?.message ?? e).split("\n")[0]}`; }
        finally { this.diffLoading = false; cx.notify(); }
      });
    }
    cx.notify();
  }

  files(c) {
    const pr = this.pr, files = pr.files ?? [], open = this.expanded.files;
    const shown = open ? files : files.slice(0, FILE_ROWS);
    return v_flex().w_full()
      .child(this.section(c, "Files", `${pr.changedFiles} · +${pr.additions} −${pr.deletions}`))
      .children(shown.map((f, i) => {
        const parts = f.path.split("/"), name = parts.pop(), on = this.openFile === f.path;
        const mark = { ADDED: "added", DELETED: "deleted", RENAMED: "renamed" }[f.changeType] ?? "";
        return v_flex().w_full().when(i > 0, (el) => el.border_t(1).border_color(c.border))
          .child(Button.new(`pr-file-${i}`).w_full().py(7).cursor_pointer().hover((s) => s.opacity(0.75))
            .on_click((_e, cx) => this.pickFile(f.path, cx))
            .child(h_flex().w_full().items_end().gap(G.md)
              .child(v_flex().flex_1().min_w(0).gap(2)
                .child(div().truncate().text_size(13).text_color(c.text).when(on, (e) => e.font_medium()).child(name))
                .when(parts.length > 0 || Boolean(mark), (el) => el.child(div().truncate().text_size(11).text_color(c.dim).child([parts.join("/"), mark].filter(Boolean).join(" · ")))))
              .child(div().text_size(11).text_color(c.dim).child(`+${f.additions} −${f.deletions}`))))
          .when(on, (el) => el.child(this.diffView(c, f.path)));
      }))
      .when(files.length > FILE_ROWS, (el) => el.child(h_flex().pt(G.sm).child(quietLink("pr-files-more", open ? "Show fewer" : `Show ${files.length - FILE_ROWS} more`, (cx) => { this.expanded.files = !open; cx.notify(); }, c))))
      .when(files.length < pr.changedFiles, (el) => el.child(div().pt(G.sm).text_size(11).text_color(c.dim).child(`GitHub lists the first ${files.length} of ${pr.changedFiles} files.`)));
  }

  render(cx) {
    if (isShown(this.id) && (this.stale || key() !== this.context)) this.refresh(cx);
    const c = tokens(theme());
    const narrow = (this.width || 368) < 560;
    let body;
    if (this.listing && this.openPrs.length) body = this.openPage(c);
    else if (this.pr) {
      const show = cfg().pr.sections, anyTask = Object.values(cfg().pr.tasks).some(Boolean);
      body = v_flex().w_full().gap(narrow ? 36 : 48)
        .child(this.hero(c, narrow))
        .when(show.description, (el) => el.child(this.description(c)))
        .when(show.people, (el) => el.child(this.people(c)))
        .when(show.checks && this.checks().length > 0, (el) => el.child(this.checksList(c)))
        .when(show.threads && this.threads.length > 0, (el) => el.child(this.discussion(c)))
        .when(show.comments !== false && visible(this.pr.comments).length > 0, (el) => el.child(this.comments(c)))
        .when(show.agent && anyTask, (el) => el.child(this.agent(c)))
        .when(show.files, (el) => el.child(this.files(c)))
        .child(div().text_size(10.5).text_color(c.dim).child(`Read from GitHub with gh${this.account ? ` as ${this.account}` : ""}${this.loadedAt ? ` · updated ${clock(this.loadedAt)}` : ""}. It rereads every ${cfg().pr.refreshSeconds} s while shown, every 20 s while a check runs.`));
    } else if (this.outside) body = this.waiting(c, "No repository here", "Focus a pane inside a git repository to see its pull requests.");
    else if (this.error) body = this.waiting(c, this.error.title, this.error.detail, quietLink("pr-retry", "Try again", (cx) => { this.loadedAt = 0; this.refresh(cx); }, c));
    else if (this.none) body = this.waiting(c, `No pull request for ${this.branch ?? "this branch"}.`,
      this.note ?? "Push the branch, then open one on GitHub.",
      quietLink("pr-create", this.busy === "Create" ? "Opening GitHub…" : "Create it on GitHub", (cx) => this.createPr(cx), c, { size: 13, color: c.text, disabled: Boolean(this.busy) }));
    else body = this.loading || !this.context ? this.skeleton(c, narrow) : this.waiting(c, "No folder", "Focus a pane inside a repository.");

    return v_flex().id("sab-pr").size_full().min_h(0).bg(c.canvas).text_color(c.text).overflow_y_scrollbar()
      .on_size_change((size, sizeCx) => { if (Math.abs((this.width || 0) - size.width) >= 1) { this.width = size.width; sizeCx.notify(); } })
      .child(h_flex().w_full().justify_center().px(narrow ? G.lg : 32).py(narrow ? G.lg : 28)
        .child(v_flex().w_full().max_w(1080).gap(narrow ? 32 : 44)
          .child(this.header(c, narrow))
          .child(body)));
  }
}
