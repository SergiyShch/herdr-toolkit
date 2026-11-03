// gh's logged-in accounts: listing them, switching the active one, adding one.
// Shared by sab-panel and sab-settings (scripts/sync-shared.sh copies it in).
import { exec, run, setShared } from "herdr";

export const ACCOUNTS = "sab.gh.accounts"; // "<machine>|owner/repo" -> account ("" = gh's active one)

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
export function addGhAccount(space) {
  logins.clear();
  setShared(ACCOUNTS, {});
  run("tab.new", { name: "gh login", space, argv: ["gh", "auth", "login"] });
}

