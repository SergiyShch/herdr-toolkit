// A changed file side by side, as an IDE shows it: the last commit (HEAD) on
// the left, the working tree on the right, one row per pair of lines so both
// halves scroll as one. A changed line is paired with its new version and the
// part that differs is marked; unchanged runs fold away (click to unfold).
// F7 / Shift+F7 (or ↓ / ↑ in the toolbar) jump between changes, and past
// the last (first) change on to the next (previous) file of the list.
// Opened by the Changes panel as a dialog of this mod with props
// { panel: "diff", root, path, on, fresh, hasHead, status, files: [those, per file] }.
// With `rev` (a commit, from the Git panel) it compares the commit's first
// parent (left) with the commit (right) instead, and doesn't watch the file.
// New for herdr-serhii.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, settings, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { insideRoot, ICON } from "./lib.js";

const ROW = 20, CONTEXT = 4, MAX_ROWS = 20000, MAX_LINE = 2000, WHOLE = "serhii.diffWholeFile";
const tidy = (s) => { s = s.replace(/\t/g, "    "); return s.length > MAX_LINE ? s.slice(0, MAX_LINE) + "… (line truncated)" : s; };

// Unified diff lines (git diff -U<all>) → side-by-side rows. A run of removed
// lines followed by added ones is paired line by line ("mod"); what is left
// over is a plain removal ("del") or addition ("add").
export function sideBySide(lines) {
  const rows = [];
  let old = 0, next = 0, dels = [], adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const l = dels[i] ?? null, r = adds[i] ?? null;
      rows.push({ kind: l && r ? "mod" : l ? "del" : "add", l, r });
    }
    dels = []; adds = [];
  };
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) {
      flush();
      // Lines between hunks that git left out: fold them like unchanged ones.
      const gap = +m[1] - (old || 1);
      if (rows.length && gap > 0) rows.push({ kind: "gap", count: gap });
      old = +m[1]; next = +m[2];
      continue;
    }
    const kind = line[0], text = tidy(line.slice(1));
    if (kind === "-") dels.push({ n: old++, text });
    else if (kind === "+") adds.push({ n: next++, text });
    else if (kind === " ") { flush(); rows.push({ kind: "same", l: { n: old++, text }, r: { n: next++, text } }); }
  }
  flush();
  return rows;
}

// The rows on screen: everything, or the changes with CONTEXT lines around
// them and a fold row for each run left out (unless unfolded).
function visible(rows, whole, open) {
  if (whole) return rows.filter((r) => r.kind !== "gap");
  const near = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "same" || r.kind === "gap") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) near[j] = true;
  });
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (near[i] || rows[i].kind !== "same" && rows[i].kind !== "gap") { out.push(rows[i++]); continue; }
    const from = i;
    while (i < rows.length && !near[i] && (rows[i].kind === "same" || rows[i].kind === "gap")) i++;
    const run = rows.slice(from, i).filter((r) => r.kind === "same"), hidden = rows.slice(from, i).some((r) => r.kind === "gap");
    if ((open.has(from) || run.length <= 2) && !hidden) out.push(...run);
    else out.push({ kind: "fold", at: from, count: run.length, hidden });
  }
  return out;
}

// The part of a changed line that differs from its old version: [before, changed, after].
function split(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [[a.slice(0, p), a.slice(p, a.length - s), a.slice(a.length - s)], [b.slice(0, p), b.slice(p, b.length - s), b.slice(b.length - s)]];
}

export class Diff {
  init(cx, p) {
    this.overlay = p.overlay;
    // The Changes list's files, in its order; the arrows walk on through them.
    const self = { root: p.root, path: p.path, on: p.on, fresh: p.fresh, hasHead: p.hasHead, status: p.status, rev: p.rev };
    this.files = Array.isArray(p.files) && p.files.length ? p.files : [self];
    this.index = this.files.findIndex((f) => f.root === p.root && f.path === p.path);
    if (this.index < 0) { this.files = [self, ...this.files]; this.index = 0; }
    this.width = 1200; this.whole = Boolean(shared(WHOLE)); this.gone = false;
    this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.show(this.index, "first", cx);
    this.ready = true;
    // Take the keyboard (F7) once the dialog is up: focus can't move during render.
    cx.timer.after(0, () => { if (!this.gone) this.handle.focus(); });
  }

  async close() { this.gone = true; this.scroll?.release(); this.scroll = null; }

  // Shows the list's file `k`, at its first or last change (`where`).
  show(k, where, cx) {
    const f = this.files[k];
    this.index = k;
    this.root = f.root; this.path = f.path; this.on = f.on ?? null;
    this.fresh = Boolean(f.fresh); this.hasHead = f.hasHead !== false; this.status = f.status ?? "M"; this.rev = f.rev ?? null;
    this.rows = []; this.view = []; this.changes = []; this.current = -1; this.open = new Set();
    this.error = null; this.loading = true; this.limited = false;
    this.load(cx, where);
    this.watch(cx);
    if (this.ready) cx.notify();
  }

  // `jump`: "first" or "last" puts that change on screen once read.
  load(cx, jump = null) {
    const { root, path, on } = this, same = () => !this.gone && this.root === root && this.path === path;
    cx.spawn(async (cx) => {
      try {
        let lines;
        if (!insideRoot(path)) throw new Error("Cannot show this file");
        if (this.rev) {
          // The commit against its first parent (a root commit: against nothing).
          const r = await exec("git", ["show", "--format=", "--diff-merges=first-parent", "--no-renames", "-U1000000", "--no-ext-diff", "--no-textconv", "--no-color", this.rev, "--", path], { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || "git show failed").trim());
          const all = r.stdout.replace(/\n$/, "").split("\n"), at = all.findIndex((l) => l.startsWith("@@"));
          if (at < 0) throw new Error(/^Binary files/m.test(r.stdout) ? "Binary file · no text diff" : "This commit doesn't change the file's text");
          lines = all.slice(at);
        } else if (this.fresh || (!this.hasHead && this.status === "A")) {
          const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
          if (text === null) throw new Error("Cannot read this file (binary, too large, or unreadable)");
          if (text.includes("\0")) throw new Error("Binary file · no text diff");
          const body = text.replace(/\n$/, "").split("\n");
          lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
        } else {
          // All of the file as context, so the two halves are the whole old and new file.
          const r = await exec("git", ["diff", ...(this.hasHead ? ["HEAD"] : []), "-U1000000", "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || "git diff failed").trim());
          const all = r.stdout.replace(/\n$/, "").split("\n"), at = all.findIndex((l) => l.startsWith("@@"));
          if (at < 0) throw new Error(/^Binary files/m.test(r.stdout) ? "Binary file · no text diff" : "No changes left in this file");
          lines = all.slice(at);
        }
        if (!same()) return;
        this.rows = sideBySide(lines.slice(0, MAX_ROWS));
        this.limited = lines.length > MAX_ROWS;
        this.error = null;
        this.layout();
        if (jump && this.changes.length) { this.current = jump === "last" ? this.changes.length - 1 : 0; this.goSoon(this.current, cx); }
      } catch (e) { if (same()) { this.error = String(e?.message ?? e); this.rows = []; this.layout(); } }
      finally { if (same()) { this.loading = false; cx.notify(); } }
    });
  }

  // Reads again when the file's folder changes (this computer only), once per save storm.
  watch(cx) {
    if (this.on || this.rev) return;
    const { root, path } = this, here = () => !this.gone && this.root === root && this.path === path;
    const dir = `${root}/${path}`.replace(/\/[^/]*$/, "");
    cx.spawn(async (cx) => {
      try {
        while (here()) {
          await watchFolder(dir);
          if (!here() || this.armed) continue;
          this.armed = cx.timer.after(400, (cx) => { this.armed = null; if (here()) this.load(cx); });
        }
      } catch {}
    });
  }

  layout() {
    this.view = visible(this.rows, this.whole, this.open);
    // Where each change starts: a changed row after an unchanged one.
    this.changes = [];
    this.view.forEach((r, i) => {
      const changed = r.kind === "mod" || r.kind === "add" || r.kind === "del";
      const before = this.view[i - 1], was = before && (before.kind === "mod" || before.kind === "add" || before.kind === "del");
      if (changed && !was) this.changes.push(i);
    });
    if (this.current >= this.changes.length) this.current = this.changes.length - 1;
  }

  go(i, notify = true, cx) {
    // Past this file's last (or before its first) change: the next (previous) file.
    const n = this.changes.length;
    if (cx && this.files.length > 1 && !this.loading && (i >= n || i < 0)) {
      const k = (this.index + (i < 0 ? -1 : 1) + this.files.length) % this.files.length;
      this.show(k, i < 0 ? "last" : "first", cx);
      return;
    }
    if (!n) return;
    this.current = (i + this.changes.length) % this.changes.length;
    this.scroll?.scroll_to_item(this.changes[this.current], "center");
    if (notify && cx) cx.notify();
  }

  // Scrolling a virtual list in the frame its row count changes leaves it
  // blank, so the jump waits for the list to lay out its new rows first.
  goSoon(i, cx) {
    cx.timer.after(60, (cx) => { if (!this.gone) this.go(i, true, cx); });
  }

  setWhole(whole, cx) {
    this.whole = whole; setShared(WHOLE, whole);
    this.layout(); cx.notify();
    this.goSoon(Math.max(0, this.current), cx);
  }

  unfold(at, cx) { this.open.add(at); this.layout(); cx.notify(); }

  openWith() {
    const file = `${this.root}/${this.path}`;
    openOverlay({ mod: "serhii-open-with", kind: "popup", width: 340, props: { file, folder: file.replace(/\/[^/]*$/, ""), machine: this.on } });
  }

  // One half of a row: its line number, then the text (a changed line marks what differs).
  side(cell, kind, parts, t, left) {
    const tint = kind === "mod" ? t.ansi4 : left ? t.ansi1 : t.ansi2;
    const empty = !cell, changed = kind !== "same";
    return h_flex().flex_1().min_w(0).h(ROW).overflow_hidden()
      .when(changed && !empty, (e) => e.bg(tint + "78")).when(changed && empty, (e) => e.bg(t.raised))
      .child(div().w(46).flex_none().pr(8).text_right().text_color(changed && !empty ? tint : t.dim).child(cell ? String(cell.n) : ""))
      .child(!cell ? div() : parts
        ? h_flex().flex_1().min_w(0).overflow_hidden()
          .child(div().flex_none().whitespace_nowrap().child(parts[0]))
          .child(div().flex_none().whitespace_nowrap().rounded(2).bg(tint + "c8").child(parts[1]))
          .child(div().flex_none().whitespace_nowrap().child(parts[2]))
        : div().flex_1().min_w(0).whitespace_nowrap().truncate().child(cell.text));
  }

  row(r, i, t) {
    if (r.kind === "fold") {
      const label = r.hidden ? `⋯ ${r.count ? r.count + " " : ""}unchanged lines` : `⋯ ${r.count} unchanged line${r.count === 1 ? "" : "s"} · click to show`;
      return div().id(`diff-fold-${r.at}`).w(this.width).h(ROW).flex_none().px(12).flex().items_center().bg(t.raised).text_color(t.dim)
        .when(!r.hidden, (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.unfold(r.at, cx)))
        .child(label);
    }
    const parts = r.kind === "mod" ? split(r.l.text, r.r.text) : null;
    const tint = r.kind === "mod" ? t.ansi4 : r.kind === "del" ? t.ansi1 : r.kind === "add" ? t.ansi2 : null;
    const here = this.current >= 0 && this.changes[this.current] === i;
    return h_flex().w(this.width).h(ROW).flex_none()
      .child(this.side(r.l, r.kind, parts?.[0], t, true))
      .child(div().w(10).h_full().flex_none().bg(t.border).when(Boolean(tint), (e) => e.child(div().w(4).h_full().mx(3).bg(here ? t.accent : tint))))
      .child(this.side(r.r, r.kind, parts?.[1], t, false));
  }

  render(cx) {
    const t = theme(), name = this.path.split("/").pop(), dir = this.path.includes("/") ? this.path.replace(/\/[^/]*$/, "") : "";
    const count = (k) => this.rows.filter((r) => r.kind === k).length;
    const add = count("add") + count("mod"), del = count("del") + count("mod");
    const btn = (id, label, tip, action, on = true) => div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(12)
      .text_color(on ? t.foreground : t.dim).tooltip(tip)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx))).child(label);
    const icon = (id, file, tip, action) => div().id(id).p(4).rounded(6).cursor_pointer().text_color(t.muted).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => action(cx)).child(svg(`${ICON}${file}.svg`).size(14));
    const n = this.changes.length, many = this.files.length > 1;
    // A virtual list takes its width from its first row, so rows get the dialog's width.
    return v_flex().id("diff").size_full().min_h(0).on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } }).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.keystroke === "f7" || e.keystroke === "alt-down") { this.go(this.current + 1, true, cx); cx.stop_propagation(); }
        else if (e.keystroke === "shift-f7" || e.keystroke === "alt-up") { this.go(this.current - 1, true, cx); cx.stop_propagation(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(`${ICON}split-right.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().font_semibold().child(name))
        .child(div().min_w(0).flex_shrink(1).truncate().text_size(12).text_color(t.dim).child(dir))
        .when(add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
        .child(div().flex_1())
        .when(many, (e) => e.child(div().text_size(11).text_color(t.dim).child(`file ${this.index + 1} / ${this.files.length}`)))
        .child(div().text_size(11).text_color(t.dim).child(n ? `${this.current >= 0 ? this.current + 1 : "–"} / ${n} change${n === 1 ? "" : "s"}` : ""))
        .child(btn("diff-prev", "↑", many ? "Previous change, then the previous file (Shift+F7)" : "Previous change (Shift+F7)", (cx) => this.go(this.current - 1, true, cx), n > 0 || many))
        .child(btn("diff-next", "↓", many ? "Next change, then the next file (F7)" : "Next change (F7)", (cx) => this.go(this.current + 1, true, cx), n > 0 || many))
        .child(btn("diff-whole", this.whole ? "Whole file" : "Changes only", this.whole ? "Fold unchanged lines" : "Show the whole file", (cx) => this.setWhole(!this.whole, cx)))
        .child(icon("diff-open-with", "open-with", "Open with…", () => this.openWith()))
        .child(icon("diff-refresh", "refresh", "Read again", (cx) => this.load(cx)))
        .child(icon("diff-close", "close", "Close (Esc)", () => closeOverlay(this.overlay))))
      .child(h_flex().h(26).flex_none().items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(div().flex_1().min_w(0).pl(54).truncate().child(this.status === "A" ? "(new file)" : `${this.rev ? `${this.rev}^` : "HEAD"}${this.on ? ` · ${this.on}` : ""}`))
        .child(div().w(10).h_full().bg(t.border))
        .child(div().flex_1().min_w(0).pl(54).truncate().child(this.status === "D" ? "(deleted)" : this.rev ?? "Working tree")))
      .child(this.error || (this.loading && !this.rows.length)
        ? div().p(16).text_color(t.dim).child(this.error ?? "Reading…")
        : div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .child(v_virtual_list("diff-rows", this.view.length, ROW, (i) => String(i),
            (range) => this.view.slice(range.start, range.end).map((r, k) => this.row(r, range.start + k, t))).track_scroll(this.scroll).size_full())
          .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(this.limited), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).border_t(1).border_color(t.border)
        .child(`Showing the first ${MAX_ROWS.toLocaleString()} lines of the diff`)));
  }
}
