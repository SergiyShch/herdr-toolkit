// gh's logged-in accounts: listing them, switching the active one, adding one.
// Shared by toolkit-panel and toolkit-settings (scripts/sync-shared.sh copies it in).
import { exec, run, setShared, spaces, notify } from "herdr";
import { cfg, setSetting } from "./config.js";

export const ACCOUNTS = "toolkit.gh.accounts"; // "<machine>|owner/repo" -> account ("" = gh's active one)

// The accounts gh is logged in to, from `gh auth status`: [{ host, login, active, ok }].
// Read at most once a minute per machine; `fresh` reads again.
const logins = new Map();
export function ghLogins(on, fresh = false) {
  const k = on ?? "", hit = logins.get(k);
  if (hit && !fresh && Date.now() - hit.at < 60000) return hit.list;
  const list = exec("gh", ["auth", "status"], { on }).then((r) => parseLogins(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)).catch(() => []);
  logins.set(k, { at: Date.now(), list });
  return list;
}
export function parseLogins(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /(✓|X|×|!)\s.*?\b(?:to|in to)\s+(\S+)\s+account\s+(\S+)/.exec(line);
    if (m) { out.push({ host: m[2], login: m[3], ok: m[1] === "✓", active: false }); continue; }
    const a = /Active account:\s*(true|false)/.exec(line);
    if (a && out.length) out[out.length - 1].active = a[1] === "true";
  }
  return out;
}

// Makes `login` gh's active account (for every gh you run too) and forgets
// what "the active account" could see.
export async function switchGhAccount(login, host = "github.com", on = null) {
  const r = await exec("gh", ["auth", "switch", "--hostname", host, "--user", login], { on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || "gh auth switch failed");
  logins.delete(on ?? "");
  setShared(ACCOUNTS, {});
}

// Logs in to one more account, in a new tab (gh adds it and makes it active).
// With `link` (and the view's `cx`, which runs the wait), the login that shows up
// is linked to that space (see linkSpace), then `done(cx)` runs.
export function addGhAccount(space, { link = false, on = null, cx = null, done = null } = {}) {
  logins.clear();
  setShared(ACCOUNTS, {});
  const open = () => run("tab.new", { name: "gh login", space, argv: ["gh", "auth", "login"] });
  if (link && space && cx) cx.spawn((cx) => watchForLogin(space, on, cx, open, done));
  else open();
}

// The account a space is linked to (github.spaces), or null.
export const spaceAccount = (space) => (space && cfg().github?.spaces?.[space]) || null;

// Links a space to a login; a falsy login unlinks it.
export function linkSpace(space, login) {
  if (!space) return Promise.resolve();
  const next = { ...(cfg().github?.spaces ?? {}) };
  if (login) next[space] = login; else delete next[space];
  return setSetting("github.spaces", next);
}

// After "Log in to another account…": reads gh auth status every 3 s for up to
// 10 minutes and links the space to the first login that wasn't there before,
// else to a login that became gh's active one (logging in again to one you had).
const watching = new Map();
async function watchForLogin(space, on, cx, open, done) {
  const before = await ghLogins(on, true);
  open();
  const had = new Set(before.map((l) => `${l.host}|${l.login}`));
  const wasActive = before.find((l) => l.active)?.login ?? null;
  const token = {};
  watching.set(space, token);
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until && watching.get(space) === token) {
    await cx.sleep(3000);
    const now = await ghLogins(on, true);
    const added = now.find((l) => l.ok && !had.has(`${l.host}|${l.login}`));
    const active = now.find((l) => l.ok && l.active);
    const login = added?.login ?? (active && active.login !== wasActive ? active.login : null);
    if (!login) continue;
    watching.delete(space);
    await linkSpace(space, login).catch(() => {});
    setShared(ACCOUNTS, {});
    const name = spaces().find((s) => s.id === space)?.name ?? "the space";
    notify({ title: `GitHub: ${login} linked to ${name}`, body: "The PR and Issues panels in this space read GitHub as this account." });
    if (done) done(cx); else cx.notify();
    return;
  }
  if (watching.get(space) === token) watching.delete(space);
}

