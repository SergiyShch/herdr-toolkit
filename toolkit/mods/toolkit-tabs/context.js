// Claude Code's context window, per conversation, from its status line.
//
// Claude Code reports how full its context is only to its status line. A
// status line that saves what it is given as `claude-statusline.json` (for
// example ~/.harp/claude-statusline.json, or herdr-agent-usage's)
// leaves a snapshot of whichever conversation drew last. This reads those
// snapshots every few seconds and keeps the last reading of each conversation
// (`session_id`), so a conversation that went quiet keeps showing its last
// value: the tab shows it dimmed, with its age in the tooltip.
//
// Which tab a reading belongs to: the conversation whose name is the agent's
// terminal title (Claude Code titles its terminal with the session name), else
// the only Claude Code pane in the reading's folder. Anything else stays blank
// rather than guess.
//
// Folders: `context.cacheRoots` in the settings (toolkit.json, or the settings dialog).
import { readTextFile, home } from "herdr";

const FILE = "claude-statusline.json";
const KEEP_MS = 3 * 86400000, KEEP_N = 60;

const expand = (p) => (p === "~" ? home() : p.startsWith("~/") ? home() + p.slice(1) : p);
// What a title says without the status glyph Claude Code puts first ("✳ Fix login").
// Symbols, dingbats, braille spinners and private-use glyphs, then spaces.
export const cleanTitle = (t) => String(t ?? "").replace(/^[\s -⯿-*·•.]+/, "").trim();

export class ClaudeContext {
  constructor() {
    try { this.readings = JSON.parse(localStorage.getItem("claude.readings") ?? "{}"); } catch { this.readings = {}; }
  }

  // Reads every snapshot; true when a reading changed.
  async poll(roots) {
    let changed = false;
    for (const root of (Array.isArray(roots) ? roots : []).filter((r) => typeof r === "string").slice(0, 8)) {
      let snap;
      try {
        const text = await readTextFile(`${expand(root)}/${FILE}`);
        if (!text) continue;
        snap = JSON.parse(text);
      } catch { continue; }
      const id = snap?.session_id, cw = snap?.context_window;
      if (!id || !cw) continue;
      const u = cw.current_usage ?? {};
      const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      const pct = Number.isFinite(cw.used_percentage) ? cw.used_percentage
        : cw.context_window_size ? Math.round((used / cw.context_window_size) * 100) : null;
      if (pct === null) continue;
      const sig = JSON.stringify([pct, used, snap.cost?.total_duration_ms ?? null]);
      const prev = this.readings[id];
      if (prev?.sig === sig) continue;
      this.readings[id] = {
        pct, size: cw.context_window_size ?? null, sig, at: Date.now(),
        name: snap.session_name ?? null, cwd: snap.workspace?.current_dir ?? snap.cwd ?? null,
        model: snap.model?.display_name ?? null,
      };
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  save() {
    const now = Date.now();
    const kept = Object.entries(this.readings).filter(([, r]) => now - r.at < KEEP_MS).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP_N);
    this.readings = Object.fromEntries(kept);
    try { localStorage.setItem("claude.readings", JSON.stringify(this.readings)); } catch {}
  }

  // The reading for a Claude Code pane, or null. `claudePanes`: every Claude Code pane.
  forPane(pane, claudePanes) {
    const all = Object.values(this.readings);
    const newest = (list) => list.sort((a, b) => b.at - a.at)[0] ?? null;
    const title = cleanTitle(pane.title).toLowerCase();
    if (title) {
      const named = newest(all.filter((r) => r.name && cleanTitle(r.name).toLowerCase() === title));
      if (named) return named;
    }
    if (pane.cwd && claudePanes.filter((p) => p.cwd === pane.cwd).length === 1) {
      return newest(all.filter((r) => r.cwd === pane.cwd));
    }
    return null;
  }
}
