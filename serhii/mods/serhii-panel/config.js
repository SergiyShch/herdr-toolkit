// herdr-serhii settings: one file, ~/.config/herdr-app/serhii.json, holding only what
// differs from DEFAULTS below. serhii-tabs reads the file every few seconds and
// publishes it as shared "serhii.settings"; every mod reads `cfg()`, which lays
// that over DEFAULTS, and re-renders when it changes. serhii-settings (the gear in
// the tab bar) edits the same file.
//
// Herdr does not let a mod import another mod's files, so this file is copied
// into each mod by scripts/sync-shared.sh. Edit serhii/shared/config.js only.
import { shared, setShared, appHome, readTextFile, writeTextFile } from "herdr";

export const SETTINGS_FILE = () => `${appHome()}/serhii.json`;
export const SHARED_KEY = "serhii.settings";

export const DEFAULTS = {
  tabs: {
    autoName: true,          // name unnamed tabs automatically
    issueKeyJira: true,      // WEB-142 from the branch or folder
    issueKeyGithub: false,   // #123 from a branch like 123-fix or issue-123
    agentTitle: true,        // the agent's own terminal title
    editorButton: true,      // Open in editor button in the tab bar
    finderButton: true,      // Open in Finder button in the tab bar
    panelLabels: true,       // text beside the panel buttons' icons
    wrap: true,              // tabs that don't fit go on a new row (the bar grows); off: they scroll
  },
  context: {
    enabled: true,           // Claude Code context % on tabs
    warnAt: 80,              // % used from which it turns red
    staleMinutes: 10,        // older readings are dimmed
    cacheRoots: ["~/.harp", "~/.local/state/herdr/plugins/herdr-agent-usage"],
  },
  gcloud: {
    enabled: true,
    label: "project",        // what the chip shows: "project" | "account" | "none"
    tokenCheck: true,        // also check the login still works (uses the network)
    tokenCheckMinutes: 10,
    refreshMinutes: 2,
    loginArgs: ["auth", "login"],  // e.g. ["auth", "login", "--update-adc"]
  },
  jira: {
    baseUrl: "",             // e.g. "https://your-site.atlassian.net": DS-1234 opens <baseUrl>/browse/DS-1234
    projects: [],            // e.g. ["DS", "WEB"]: only these keys count, and lowercase ds-1234 in branches too
  },
  panels: { files: true, changes: true, git: true, pr: true, issues: false },
  github: {
    autoAccount: true,       // find the logged-in gh account that can see each repository
    accounts: {},            // pin by owner: { "my-org": "my-login" }
    repos: {},               // pin by repository: { "my-org/app": "my-login" }; wins over an owner pin
  },
  agent: {
    prefer: "claude",        // programs.json key of the agent tasks start with; "" = first installed
  },
  pr: {
    refreshSeconds: 60,
    mergeMethod: "auto",     // "auto" | "squash" | "merge" | "rebase"
    createDraft: true,       // Create PR (Changes and PR panels) opens a draft
    rowActions: true,        // Review / Describe / browser on the open list
    sections: { description: true, people: true, checks: true, threads: true, comments: true, agent: true, files: true },
    tasks: { review: true, describe: true, explain: true, feedback: true, conflicts: true },
  },
  issues: { limit: 100, refreshSeconds: 120, startButton: true },
  git: { graphLimit: 300 },  // commits the Git panel's graph reads (50–2000)
  changes: {
    commit: true,
    createPr: true,          // Create PR beside Commit: push the branch and gh pr create --fill
    nested: true,            // a folder that is not a repository: the repositories inside it, one section each
    scanDepth: 2,            // how many folders deep to look for them (1-5)
    maxRepos: 100,           // at most this many (up to 200)
  },
  // Task prompts, overriding the built-in ones. Placeholders: {number} {url}
  // {title} {head} {base}. Keys: review, describe, explain, feedback,
  // conflicts, issue.
  prompts: {},
};

// ---- Jira keys -------------------------------------------------------------------

// Things shaped like a key that aren't tickets.
const NOT_JIRA = new Set(["UTF", "SHA", "ISO", "RFC", "HTTP", "HTTPS", "TLS", "SSL", "AES", "RSA", "MD", "CVE", "GPT", "COVID", "ECMA", "ES", "IPV", "PEP", "ARM", "AMD", "WIN", "MAC", "IOS", "MACOS", "WCAG", "ISBN", "EAN", "UPC", "GMT", "UTC", "PR", "V"]);
const KEY = /(^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})(?![A-Za-z0-9])/g;

// Every Jira key in some text (DS-1234), once each, in order. Keys must be
// upper case, except with `loose` (branch and folder names) when jira.projects
// lists the project: then ds-1234 counts too. With jira.projects set, only
// those projects count.
export function jiraKeys(text, { loose = false } = {}) {
  const projects = (cfg().jira?.projects ?? []).map((p) => String(p).toUpperCase());
  const out = [];
  for (const m of String(text ?? "").matchAll(KEY)) {
    const raw = m[2], project = raw.toUpperCase();
    if (projects.length ? !projects.includes(project) : NOT_JIRA.has(project)) continue;
    if (raw !== project && !(loose && projects.length)) continue;
    if (!/^[A-Z]/.test(project)) continue;
    const key = `${project}-${m[3]}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}
// The first Jira key in some text, or null.
export const jiraKey = (text, opts) => jiraKeys(text, opts)[0] ?? null;

// Markdown with each Jira key made a link to its ticket; code, links and URLs left alone.
export function linkJira(md) {
  if (!jiraSite()) return md;
  return String(md ?? "").split(/(```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]*\)|<[^>\n]*>|https?:\/\/\S+)/).map((part, i) => i % 2 ? part
    : part.replace(KEY, (all, pre, project, n) => {
      const url = jiraUrl(`${project}-${n}`);
      return url && jiraKeys(`${project}-${n}`).length ? `${pre}[${project}-${n}](${url})` : all;
    })).join("");
}

// The Atlassian site from jira.baseUrl ("your-site.atlassian.net" or any URL on it), or null.
export function jiraSite() {
  const raw = String(cfg().jira?.baseUrl ?? "").trim();
  if (!raw) return null;
  const m = /^(?:https?:\/\/)?([^/\s]+)/i.exec(raw);
  return m ? `https://${m[1]}` : null;
}
// Where a Jira key opens: <site>/browse/DS-1234, or null without a site.
export function jiraUrl(key) {
  const site = jiraSite();
  return site && key && /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(key) ? `${site}/browse/${key}` : null;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base[k]) && isObj(v) ? merge(base[k], v) : v;
  return out;
}

// What `value` changes from `base`: the object to save.
export function diff(base, value) {
  if (isObj(base) && isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const d = diff(base[k], v);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(value) ? undefined : value;
}

let memo = { raw: undefined, value: DEFAULTS };
// The settings now: DEFAULTS with the file's values over them.
export function cfg() {
  const raw = shared(SHARED_KEY);
  if (raw !== memo.raw) memo = { raw, value: isObj(raw) ? merge(DEFAULTS, raw) : DEFAULTS };
  return memo.value;
}

export function get(path) {
  return path.split(".").reduce((v, k) => (v == null ? v : v[k]), cfg());
}

function setPath(obj, path, value) {
  const keys = path.split("."), out = JSON.parse(JSON.stringify(obj ?? {}));
  let at = out;
  for (const k of keys.slice(0, -1)) { if (!isObj(at[k])) at[k] = {}; at = at[k]; }
  at[keys[keys.length - 1]] = value;
  return out;
}

// Reads the file. { text, value } or { text: null } when there is none; throws on bad JSON.
export async function readSettings() {
  const text = await readTextFile(SETTINGS_FILE());
  if (!text) return { text: null, value: {} };
  const value = JSON.parse(text);
  if (!isObj(value)) throw new Error("serhii.json must hold a JSON object");
  return { text, value };
}

// Saves `full` (complete settings) as the diff from DEFAULTS, and publishes it.
export async function saveSettings(full) {
  const over = diff(DEFAULTS, full) ?? {};
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = await readTextFile(SETTINGS_FILE()).catch(() => null);
    try {
      await writeTextFile(SETTINGS_FILE(), JSON.stringify(over, null, 2) + "\n", now ?? null);
      setShared(SHARED_KEY, over);
      return over;
    } catch (e) { if (attempt) throw e; }
  }
}

// One setting, by dotted path ("gcloud.enabled").
export function setSetting(path, value) {
  return saveSettings(setPath(cfg(), path, value));
}

export function resetSettings() {
  return saveSettings(DEFAULTS);
}

// A task prompt: the configured template, else the built-in text.
export function prompt(kind, vars, fallback) {
  const t = cfg().prompts?.[kind];
  if (typeof t !== "string" || !t.trim()) return fallback;
  return t.replace(/\{(number|url|title|head|base)\}/g, (_m, k) => String(vars[k] ?? ""));
}
