// gcloud configurations and the space each one is linked to (gcloud.spaces in
// toolkit.json: space id -> configuration name). A linked space's chip reads its
// configuration (`--configuration`), and new terminals in it get
// CLOUDSDK_ACTIVE_CONFIG_NAME from toolkit/shell/space-env.zsh.
// Shared by toolkit-tabs, toolkit-panel and toolkit-settings (scripts/sync-shared.sh copies it in).
import { exec, run, spaces } from "herdr";
import { cfg, setSetting } from "./config.js";

// gcloud's configurations: [{ name, active, account, project }], [] when gcloud
// is missing or fails.
export async function gcloudConfigs() {
  const r = await exec("gcloud", ["config", "configurations", "list", "--format=json"]).catch(() => null);
  if (!r || r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout || "[]").map((c) => ({
      name: c.name, active: Boolean(c.is_active),
      account: c.properties?.core?.account ?? null, project: c.properties?.core?.project ?? null,
    }));
  } catch { return []; }
}

// The configuration a space is linked to, or null.
export const spaceConfig = (space) => (space && cfg().gcloud?.spaces?.[space]) || null;

// Links a space to a configuration; a falsy name unlinks it.
export function linkGcloudSpace(space, name) {
  if (!space) return Promise.resolve();
  const next = { ...(cfg().gcloud?.spaces ?? {}) };
  if (name) next[space] = name; else delete next[space];
  return setSetting("gcloud.spaces", next);
}

// A configuration name from a space's name: lowercase letters, digits and
// hyphens, starting with a letter (what gcloud accepts).
export function configName(text) {
  const s = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z]/.test(s) ? s : `space-${s || "1"}`.replace(/-$/, "");
}

// `gcloud auth login` (gcloud.loginArgs) in a new tab of `space`, for its
// linked configuration when it has one.
export function gcloudLogin(space) {
  const args = cfg().gcloud.loginArgs, linked = spaceConfig(space);
  run("tab.new", { name: "gcloud login", space, argv: ["gcloud", ...(Array.isArray(args) && args.length ? args : ["auth", "login"]), ...(linked ? ["--configuration", linked] : [])] });
}

// A new configuration in a new tab of `space`: asks for its name (the space's
// name by default), creates it without making it active, logs in to it and
// sets a project. toolkit-tabs then links it (watchNewConfig).
const NEW_CONFIG = `d=$1
printf 'Name for the new gcloud configuration [%s]: ' "$d"; read -r n; n=\${n:-$d}
gcloud config configurations create "$n" --no-activate || { printf 'Press enter to close. '; read -r _; exit 1; }
gcloud auth login --configuration "$n" || { printf 'Press enter to close. '; read -r _; exit 1; }
printf 'Project id for %s (empty: none): ' "$n"; read -r p
[ -n "$p" ] && gcloud config set project "$p" --configuration "$n"
printf '\\nDone: herdr-toolkit links %s to this space. Press enter to close. ' "$n"; read -r _`;
export function newGcloudConfig(space) {
  const name = configName(spaces().find((s) => s.id === space)?.name);
  run("tab.new", { name: "gcloud config", space, argv: ["sh", "-c", NEW_CONFIG, "sh", name] });
}

// After newGcloudConfig: reads the configurations every 3 s for up to 10 minutes
// and links `space` to the first new one that has an account. `before`: the
// names there were. Runs in the caller's view (`cx`); resolves to the name or null.
export async function watchNewConfig(space, before, cx) {
  const had = new Set(before);
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until) {
    await cx.sleep(3000);
    const fresh = (await gcloudConfigs()).find((c) => !had.has(c.name) && c.account);
    if (!fresh) continue;
    await linkGcloudSpace(space, fresh.name);
    return fresh.name;
  }
  return null;
}
