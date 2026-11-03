// Shared by the panels of the sab-panel mod (files, changes, pr, issues, preview).
// Derived from Kanso's kanso-panel/lib.js (jlopezlira, https://github.com/jlopezlira/herdr-kanso, Apache-2.0).
// Changed for herdr-sab: no layout writes. The panels live as children of the
// `panel-body` stack in layouts/sab.json; sab-tabs picks one with
// layout.select and shows or hides the `panel` column. A hidden panel stays
// alive, so each one checks `isShown(id)` before it reads git or GitHub.
import { div } from "gpui-kit";
import { EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, layout, run, theme, settings, exec, knownAgents, notify, shared, setShared } from "herdr";
import { cfg } from "./config.js";
export { cfg, prompt } from "./config.js";

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

const ACCOUNTS = "sab.gh.accounts"; // "<machine>|owner/repo" -> account ("" = gh's active one)
const probing = new Map();

// The repository's GitHub owner/name, from its origin remote.
export async function githubRepo(root, on) {
  const r = await exec("git", ["remote", "get-url", "origin"], { cwd: root, on }).catch(() => null);
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(r?.stdout ?? "");
  return m ? { owner: m[1], name: m[2] } : null;
}

// Which gh account reads this repository: pinned in settings (github.accounts,
// by owner), else the one found earlier, else the first logged-in account that
// can see it (gh's active one first). Remembered in shared state.
export async function ghAccount(root, on) {
  const repo = await githubRepo(root, on);
  if (!repo) return { repo: null, account: "" };
  const gh = cfg().github ?? {}, pinned = gh.accounts ?? {};
  const pin = pinned[repo.owner] ?? Object.entries(pinned).find(([k]) => k.toLowerCase() === repo.owner.toLowerCase())?.[1];
  if (pin) return { repo, account: pin, pinned: true };
  if (gh.autoAccount === false) return { repo, account: "" };
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
  const st = await exec("gh", ["auth", "status"], { cwd, on }).catch(() => null);
  const logins = [...new Set([...`${st?.stdout ?? ""}\n${st?.stderr ?? ""}`.matchAll(/account (\S+)/g)].map((m) => m[1]))];
  for (const login of logins) if (await can(login)) return login;
  return null; // nobody can: don't remember, try again next time
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
  return repo ? `${who} can't see ${repo.owner}/${repo.name}. Log in with one that can (gh auth login), or pin one for ${repo.owner} in herdr-sab settings → GitHub.` : null;
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
      .child(TextView.markdown(id, text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n\n… (file truncated)" : text).selectable(true)));
}
