// Derived from the `files` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: root no longer draws its own rounded, bordered card.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-files.
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-files; one of the kanso-panel mod's panels.
// Modified for herdr-serhii: one of the serhii-panel mod's panels; reads only while shown.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, v_virtual_list, Scrollbar } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, window, openOverlay } from "herdr";
import { location, key, codeState, markdownView, isMarkdown, insideRoot, isShown, ICON } from "./lib.js";

const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // The path is the process's cwd, not part of -Command: PowerShell joins
    // everything after -Command into the script, so a folder name could run.
    const script = "& { @(Get-ChildItem -LiteralPath . -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress }";
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: path });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  // One process and no shell: find prints each directory twice in a row (a
  // name can't appear twice in a folder), so the type costs no extra call.
  // Entries are not followed (-type d is false for a link to a folder); -H
  // follows only the folder itself, as a link to it should open.
  const fast = await exec("find", ["-H", ".", "-mindepth", "1", "-maxdepth", "1", "!", "-name", ".git",
    "(", "-type", "d", "-print0", "-print0", "-o", "-print0", ")"], { cwd: path, on }).catch(() => null);
  if (fast?.code === 0) {
    const out = [], text = fast.stdout;
    for (let at = 0, last = null; at < text.length && out.length <= PER_FOLDER + 1;) {
      const end = text.indexOf("\0", at);
      if (end < 0) break;
      const name = text.slice(at + 2, end); // drop "./"
      at = end + 1;
      if (name === last) { out[out.length - 1].dir = true; last = null; continue; }
      out.push({ name, dir: false }); last = name;
    }
    // One past the cap tells the panel the folder was cut short.
    return out.slice(0, PER_FOLDER + 1);
  }
  // Fallback (no find on that machine, or a folder so large the output went
  // past exec's limit): stream NUL-separated names. Bash's read -d keeps the
  // stream bounded; read one extra entry to detect truncation.
  const script = `
n=0
find -H "$1" -mindepth 1 -maxdepth 1 ! -name .git -print0 2>/dev/null |
while IFS= read -r -d '' p; do
  name=\${p##*/}
  if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi
  printf '%s\\0%s\\0' "$kind" "$name"
  n=$((n+1))
  [ "$n" -ge ${PER_FOLDER + 1} ] && break
done
test -d "$1"`;
  const r = await exec("bash", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Lives in the panel stack while hidden: refresh() returns early then, and the
// next render after it is shown catches up.
export class Files {
  init(cx) {
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async cx => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.later(cx); } }
      catch { if (this.watched === root) this.watched = null; }
    });
  }

  // A save storm wakes the watch once per file. Fold that into one refresh.
  later(cx) {
    this.queued = true;
    if (this.armed) return;
    this.armed = cx.timer.after(400, (cx) => {
      this.armed = null;
      if (!this.queued) return;
      if (this.loading) { this.later(cx); return; }
      this.queued = false;
      this.refresh(cx);
    });
  }

  async loadFolder(path, context) {
    if (path && !insideRoot(path)) return;
    const on = this.on, root = this.root;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (key() !== context || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (!isShown(this.id)) { this.stale = true; return; }
    this.stale = false;
    if (this.loading) { this.later(cx); return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set();
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) await this.loadFolder(path, context);
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec("git", ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (key() !== context) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (key() === context) this.error = String(e); }
          finally { this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // The file in a code editor of your choice (the `open-with` mod), or in
  // Kanso's own preview panel, which that list offers for text files.
  openWith(path) {
    if (!insideRoot(path)) return;
    openOverlay({ mod: "serhii-open-with", kind: "popup", width: 340, props: { file: `${this.root}/${path}`, folder: this.root, machine: this.on } });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.text = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    if (!insideRoot(path)) { this.fileError = "Cannot preview this file"; return; }
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || key() !== context) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        // Markdown is rendered (the SDK's TextView); anything else is read-only code.
        if (isMarkdown(path)) this.text = text; else this.code = codeState(path, text);
      } catch { if (this.file === path && key() === context) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Plain rows, so a frame builds elements only for the ones on screen.
  flat(prefix, depth, out) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({ path, entry, depth, mark: this.marks[`${this.root}/${path}`] });
      if (entry.dir && this.folders.has(path)) this.flat(path, depth + 1, out);
    }
    return out;
  }

  row({ path, entry, depth, mark }, t) {
    const open = this.folders.has(path);
    return h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
      .child(entry.dir ? svg(`mods/serhii-panel/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/serhii-panel/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(entry.name))
      .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
  }

  render(cx) {
    if (isShown(this.id) && (this.stale || key() !== this.context)) this.refresh(cx);
    const t = theme();
    const items = this.file ? [] : this.flat("", 0, []);
    return v_flex().id("files").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.file), el => el.child(div().id("files-open-with").p(4).rounded(6).cursor_pointer().text_color(t.muted).tooltip("Open with…")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.openWith(this.file))
          .child(svg(`${ICON}open-with.svg`).size(14)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).p(6)
        .when(items.length > 0, (el) => el.child(div().flex_1().min_h(0).relative()
          .child(v_virtual_list("files-rows", items.length, 28, (i) => items[i].path, (range) => items.slice(range.start, range.end).map((item) => this.row(item, t)))
            // Item renderers run during native layout, where per-row handlers
            // are forbidden. The list owns two handlers, keyed by file path.
            .on_item_click((path, cx) => {
              const item = items.find((item) => item.path === path);
              if (item) item.entry.dir ? this.toggle(path, cx) : this.show(path, cx);
            })
            .on_item_secondary_click((path) => {
              const item = items.find((item) => item.path === path);
              if (item && !item.entry.dir) this.openWith(path);
            }).size_full())
          .child(Scrollbar.vertical("files-rows").absolute().inset_0())))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0)
        : this.text !== null ? markdownView("files-md", this.text, t)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
