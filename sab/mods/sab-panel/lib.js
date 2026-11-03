// Shared by the panels of the sab-panel mod (files, changes, pr, issues, preview).
// Derived from Kanso's kanso-panel/lib.js (jlopezlira, https://github.com/jlopezlira/herdr-kanso, Apache-2.0).
// Changed for herdr-sab: no layout writes. The panels live as children of the
// `panel-body` stack in layouts/sab.json; sab-tabs picks one with
// layout.select and shows or hides the `panel` column. A hidden panel stays
// alive, so each one checks `isShown(id)` before it reads git or GitHub.
import { div, svg } from "gpui-kit";
import { EditorState, TextView, Button, Popover, v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, layout, run, theme, settings, exec, knownAgents, notify, shared, setShared, openOverlay } from "herdr";
import { cfg, setSetting, jiraKeys, jiraUrl, linkJira } from "./config.js";
import { ghLogins, switchGhAccount, addGhAccount, ACCOUNTS } from "./gh.js";
export { ghLogins, switchGhAccount, addGhAccount } from "./gh.js";
export { cfg, prompt, jiraKey, jiraKeys, jiraUrl, linkJira } from "./config.js";

export const ICON = "mods/sab-panel/icons/";

export function walkLayout(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = walkLayout(child, id);
    if (found) return found;
  }
  return null;
}

// Which panel the side column shows now, or null when it is closed.
export function shownPanel(tree = layout()) {
  const wrap = walkLayout(tree, "panel"), body = walkLayout(tree, "panel-body");
  if (!body || wrap?.hidden || body.hidden) return null;
  return body.active ?? null;
}
export const isShown = (id) => shownPanel() === id;

// Shows one panel in the side column (as the tab bar's buttons do).
export function showPanel(id) {
  if (!id) { run("layout.hide", { id: "panel" }); return; }
  run("layout.select", { stack: "panel-body", child: id });
  run("layout.show", { id: "panel" });
}

// A relative path that stays inside its root: no absolute path, no ".." segment.
export function insideRoot(path) {
  if (!path || typeof path !== "string" || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split(/[\\/]/).every((part) => part !== "..");
}

// Where the focused pane is: its folder, the machine it is on (null: this
// computer) and its space. The panel follows the session you are looking at.
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
// The context a read belongs to: the folder and the machine (not the space).
export const key = () => { const { cwd, on } = location(); return JSON.stringify({ cwd, on }); };

// Numbers each diff line once, so a frame only draws the rows on screen.
export function diffRows(lines, { max, width } = {}) {
  let old = 0, next = 0;
  return (max ? lines.slice(0, max) : lines).map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], body = line.slice(1) || " ", text = width ? body.slice(0, width) : body;
    if (kind === "-") return { kind, number: old++, text };
    if (kind === "+") return { kind, number: next++, text };
    if (kind === " ") { old++; return { kind, number: next++, text }; }
    return { kind: "", text: line };
  });
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - (typeof iso === "number" ? iso : Date.parse(iso))) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
export const labelColor = (hex) => { const h = String(hex ?? "").replace(/^#/, ""); return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h}` : null; };
export const openUrl = (url) => exec("open", [url]).catch(() => exec("xdg-open", [url])).catch(() => {});

// ---- GitHub CLI, per repository account ---------------------------------------------

// Runs gh as one of its logged-in accounts. The token is read inside the shell,
// so it never shows in a process list. "" runs gh as its active account.
const AS = 'u=$1; shift; t=$(gh auth token -u "$u" 2>/dev/null) || { echo "gh has no login for $u (gh auth login)" >&2; exit 97; }; GH_TOKEN=$t exec gh "$@"';
export function ghAs(account, args, opts) {
  return account ? exec("sh", ["-c", AS, "sh", account, ...args], opts) : exec("gh", args, opts);
}

const probing = new Map();

// The repository's GitHub owner/name, from its origin remote.
export async function githubRepo(root, on) {
  const r = await exec("git", ["remote", "get-url", "origin"], { cwd: root, on }).catch(() => null);
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(r?.stdout ?? "");
  return m ? { owner: m[1], name: m[2] } : null;
}

// The account pinned for a repository: by owner/name first, then by owner.
function pinFor(repo) {
  const gh = cfg().github ?? {}, low = (s) => String(s).toLowerCase();
  const find = (map, k) => Object.entries(map ?? {}).find(([x]) => low(x) === low(k))?.[1];
  return find(gh.repos, `${repo.owner}/${repo.name}`) ?? find(gh.accounts, repo.owner) ?? null;
}

// Which gh account reads this repository: pinned in settings (github.repos, then
// github.accounts by owner), else the one found earlier, else the first
// logged-in account that can see it (gh's active one first). Remembered in shared state.
export async function ghAccount(root, on) {
  const repo = await githubRepo(root, on);
  if (!repo) return { repo: null, account: "" };
  const pin = pinFor(repo);
  if (pin) return { repo, account: pin, pinned: true };
  if (cfg().github?.autoAccount === false) return { repo, account: "" };
  const k = `${on ?? ""}|${repo.owner}/${repo.name}`.toLowerCase();
  const known = shared(ACCOUNTS) ?? {};
  if (k in known) return { repo, account: known[k] };
  if (!probing.has(k)) probing.set(k, probe(repo, root, on).then((account) => {
    probing.delete(k);
    if (account !== null) setShared(ACCOUNTS, { ...(shared(ACCOUNTS) ?? {}), [k]: account });
    return account ?? "";
  }));
  return { repo, account: await probing.get(k) };
}

async function probe(repo, cwd, on) {
  const can = (account) => ghAs(account, ["api", `repos/${repo.owner}/${repo.name}`, "--jq", ".full_name"], { cwd, on })
    .then((r) => r.code === 0).catch(() => false);
  if (await can("")) return "";
  for (const { login, active, ok } of await ghLogins(on)) if (ok && !active && await can(login)) return login;
  return null; // nobody can: don't remember, try again next time
}

// Pins a repository to one account ("" or null: back to automatic).
export function setRepoAccount(repo, login) {
  if (!repo) return Promise.resolve();
  const name = `${repo.owner}/${repo.name}`, low = name.toLowerCase();
  const repos = Object.fromEntries(Object.entries(cfg().github?.repos ?? {}).filter(([k]) => k.toLowerCase() !== low));
  if (login) repos[name] = login;
  return setSetting("github.repos", repos);
}

// The account menu in the PR and Issues panels' headers: which gh login reads
// this repository. Picking one pins the repository to it; Automatic removes the
// pin. Making a login gh's active one lives in settings → GitHub. `p` is the
// panel: it has account, ghRepo, pinned, on, logins and reload(cx).
export function accountPicker(p, c, prefix) {
  const id = `${prefix}-gh`, list = p.logins ?? [];
  const active = list.find((l) => l.active)?.login;
  const who = p.account || active || "gh";
  const avatar = (login, size = 18) => div().size(size).flex_none().flex().items_center().justify_center().rounded_full()
    .bg(c.subtle).border_1().border_color(c.border).text_size(size * 0.5).text_color(c.muted).child((login[0] ?? "?").toUpperCase());
  const trigger = Button.new(`${id}-trigger`).h(26).pl(4).pr(6).gap(6).flex_none().items_center().rounded(13).cursor_pointer()
    .border_1().border_color(p.accountOpen ? c.border : "#00000000")
    .accessibility_label(`GitHub account: ${who}`).tooltip(`Reading GitHub as ${who}${p.pinned ? " (pinned)" : ""}`)
    .hover((s) => s.bg(c.subtle))
    .child(avatar(who))
    .child(div().max_w(110).truncate().text_size(12).text_color(c.text).child(who))
    .child(svg(`${ICON}chevron-down.svg`).size(11).text_color(c.dim));
  const popover = Popover.new(id).trigger(trigger).anchor("top_right").open(Boolean(p.accountOpen))
    .on_open_change((open, cx) => {
      p.accountOpen = open; cx.notify();
      if (open) cx.spawn(async (cx) => { p.logins = await ghLogins(p.on, true); cx.notify(); });
    });
  if (!p.accountOpen) return popover;
  const repo = p.ghRepo ? `${p.ghRepo.owner}/${p.ghRepo.name}` : null;
  const close = (cx) => { p.accountOpen = false; cx.notify(); };
  const pick = (login, cx) => {
    close(cx);
    setRepoAccount(p.ghRepo, login).then(() => { if (!login && p.root) forgetGhAccount(p.root, p.on, p.ghRepo); })
      .catch((e) => notify({ title: "Could not save the account", body: String(e?.message ?? e), level: "error" }))
      .finally(() => cx.spawn(async (cx) => p.reload(cx)));
  };
  // One choice: a check column, then what it is and a quiet second line.
  const choice = (key, lead, title, sub, checked, onClick, disabled = false) => Button.new(`${id}-${key}`).w_full().px(8).py(6).gap(10).items_center().rounded(6)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(c.subtle))).when(disabled, (el) => el.opacity(0.5))
    .accessibility_label(title).on_click((_e, cx) => { if (!disabled) onClick(cx); })
    .child(lead)
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().truncate().text_size(12.5).text_color(c.text).child(title))
      .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(c.dim).child(sub))))
    .child(div().w(14).flex_none().text_size(12).text_color(c.text).child(checked ? "✓" : ""));
  const action = (key, icon, title, onClick) => Button.new(`${id}-${key}`).w_full().px(8).py(6).gap(10).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(c.subtle)).accessibility_label(title).on_click((_e, cx) => onClick(cx))
    .child(div().size(18).flex_none().flex().items_center().justify_center().child(svg(`${ICON}${icon}.svg`).size(13).text_color(c.muted)))
    .child(div().flex_1().text_size(12.5).text_color(c.text).child(title));
  const found = !p.pinned ? (p.account || active) : null;
  return popover.content(v_flex().w(260).p(G.xs).gap(1).rounded(8).bg(c.popover).border_1().border_color(c.border)
    .child(div().px(8).pt(6).pb(6).text_size(11).text_color(c.dim).truncate().child(repo ? `GitHub account for ${repo}` : "GitHub account"))
    .child(choice("auto", div().size(18).flex_none().flex().items_center().justify_center().child(svg(`${ICON}refresh.svg`).size(13).text_color(c.muted)),
      "Automatic", found ? `uses ${found}, the first that can see it` : "the first account that can see it", !p.pinned, (cx) => pick(null, cx), !repo))
    .children(list.map((l, i) => choice(`l${i}`, avatar(l.login), l.login,
      [l.active ? "gh's active account" : null, l.host !== "github.com" ? l.host : null, l.ok ? null : "login broken"].filter(Boolean).join(" · ") || null,
      Boolean(p.pinned) && p.account === l.login, (cx) => pick(l.login, cx), !repo || !l.ok)))
    .when(!list.length, (el) => el.child(div().px(8).py(6).text_size(11.5).text_color(c.dim).child(p.logins ? "gh is logged in to no account." : "Reading gh auth status…")))
    .child(div().mx(8).my(4).h(1).bg(c.border))
    .child(action("add", "plus", "Add an account…", (cx) => { close(cx); addGhAccount(spaces().find((s) => s.active)?.id); }))
    .child(action("settings", "settings", "Account settings…", (cx) => { close(cx); openOverlay({ mod: "sab-settings", kind: "dialog", width: 820, height: 620, props: { section: "github" } }); })));
}

// ---- Creating a pull request -----------------------------------------------------

// git that fails instead of waiting for a password prompt nobody can see.
const GIT_NO_PROMPT = 'GIT_TERMINAL_PROMPT=0 exec git "$@"';
const PR_EXISTS = /already exists[^\n]*\n?\s*(https:\/\/\S+)/i;

// The remote's default branch (origin/HEAD), else main or master if origin has one.
export async function defaultBranch(root, on) {
  const head = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root, on }).catch(() => null);
  if (head?.code === 0 && head.stdout.trim().startsWith("origin/")) return head.stdout.trim().slice(7);
  for (const name of ["main", "master"]) {
    const r = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`], { cwd: root, on }).catch(() => null);
    if (r?.code === 0) return name;
  }
  return null;
}

// Pushes the current branch (setting its upstream the first time) and opens a
// pull request for it with `gh pr create --fill`, as the gh account that can
// see the repository. Draft unless pr.createDraft is off. Resolves to
// { url, existed }; throws an Error whose message says what to do.
export async function createPr(root, on) {
  const git = (args) => exec("git", args, { cwd: root, on });
  const branch = (await git(["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new Error("HEAD is detached: check out a branch first");
  const base = await defaultBranch(root, on);
  if (base && branch === base) throw new Error(`you're on ${base}: make a branch for these commits first`);
  const { repo, account } = await ghAccount(root, on);
  if (!repo) throw new Error("origin is not a GitHub repository");
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const push = await exec("sh", ["-c", GIT_NO_PROMPT, "sh", "push", ...(up.code === 0 ? [] : ["-u", "origin", "HEAD"])], { cwd: root, on });
  if (push.code !== 0) throw new Error(`push failed: ${(push.stderr || push.stdout).trim().split("\n").filter(Boolean).pop() ?? ""}`);
  const r = await ghAs(account, ["pr", "create", "--fill", ...(cfg().pr.createDraft === false ? [] : ["--draft"]), "--head", branch], { cwd: root, on });
  const out = `${r.stdout}\n${r.stderr}`;
  const existing = PR_EXISTS.exec(out);
  if (existing) return { url: existing[1], existed: true };
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || "gh pr create failed");
  const url = out.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
  return { url, existed: false };
}

// Forget the account found for a repository (after it stopped working).
export function forgetGhAccount(root, on, repo) {
  if (!repo) return;
  const k = `${on ?? ""}|${repo.owner}/${repo.name}`.toLowerCase(), known = { ...(shared(ACCOUNTS) ?? {}) };
  if (k in known) { delete known[k]; setShared(ACCOUNTS, known); }
}

// Said when a repository can't be read: which account tried, and what to do.
export function noAccess(repo, account) {
  const who = account ? `gh account ${account}` : "gh's active account";
  return repo ? `${who} can't see ${repo.owner}/${repo.name}. Pick another account from the gh menu above, or add one that can see it.` : null;
}
export const NOT_FOUND = /could not resolve to a repository|not found \(http 404\)|http 404/i;

// Starts the preferred installed agent (settings: agent.prefer) in a new tab of the
// space, in `folder`, with `task` as its first message. The tab gets `name`:
// a name given here counts as typed, so it wins over the automatic one.
export function startAgent({ name, folder, task, on, space }) {
  return knownAgents({ on }).then((list) => {
    const prefer = cfg().agent.prefer;
    const agent = (prefer ? list.find((a) => a.installed && a.key === prefer) : null) ?? list.find((a) => a.installed);
    if (!agent) throw new Error("no agent is installed");
    run("tab.new", { name, space, folder, argv: agent.run, task });
  }).catch((e) => notify({ title: "Could not start the agent", body: String(e?.message ?? e), level: "error" }));
}

// Design tokens shared by the PR and Issues panels (Kanso's Spend scale).
export const G = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export function tokens(t) {
  return {
    canvas: t.canvas ?? t.background, text: t.foreground, muted: t.muted ?? t.dim, dim: t.dim,
    border: t.border, subtle: t.hover ?? t.raised, selected: t.selected ?? t.hover ?? t.raised, popover: t.popover ?? t.surface,
    primary: t.solid ?? t.foreground, primaryText: t.solid_foreground ?? t.background,
    red: t.ansi1, green: t.ansi2, yellow: t.ansi3, violet: t.ansi5, mono: settings().font_family ?? "JetBrains Mono",
  };
}

// ---- Showing a file --------------------------------------------------------------

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const MAX_TEXT = 400000;
export const ext = (path) => (path.includes(".") ? path.split(".").pop().toLowerCase() : "");
export const isMarkdown = (path) => ["md", "markdown", "mdx"].includes(ext(path));

// A read-only editor state for a code or text file, in the terminal's font,
// highlighted in the theme's ANSI hues. Release it when done.
export function codeState(path, text) {
  const t = theme(), e = ext(path) || "txt";
  return EditorState.new({ language: LANG[e] ?? e, readonly: true,
    value: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n… (file truncated)" : text,
    font_family: settings().font_family, font_size: 12,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
}

// Markdown as the SDK renders it (`TextView.markdown`), selectable, scrolling.
export function markdownView(id, text, t) {
  return div().id(`${id}-scroll`).flex_1().min_h(0).overflow_y_scrollbar()
    .child(div().px(16).py(12).text_size(13).text_color(t.foreground)
      .child(TextView.markdown(id, linkJira(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n\n… (file truncated)" : text)).selectable(true)
        .on_link_click((url) => { if (/^https?:\/\//.test(url)) openUrl(url); })));
}

// A small chip per Jira key found in `texts` (DS-1234), each opening its ticket.
// Nothing when no Jira site is set. A click doesn't reach the row under it.
export function jiraChips(id, texts, c, { loose = false } = {}) {
  const keys = [...new Set((Array.isArray(texts) ? texts : [texts]).flatMap((x, i) => jiraKeys(x, { loose: loose && i > 0 })))];
  return keys.map((k) => ({ k, url: jiraUrl(k) })).filter((x) => x.url).slice(0, 6).map(({ k, url }, i) =>
    Button.new(`${id}-jira-${i}`).h(20).px(6).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
      .border_1().border_color(c.border).hover((s) => s.bg(c.subtle)).tooltip(`Open ${k} in Jira`).accessibility_label(`Open ${k} in Jira`)
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(url); })
      .child(svg(`${ICON}ticket.svg`).size(11).text_color(c.muted))
      .child(div().text_size(11).text_color(c.text).child(k)));
}
