// One file in the side panel: Markdown rendered by the SDK (TextView),
// anything else as read-only code. Which file: shared "serhii.preview"
// ({ path, on }), set by serhii-open-with's "Preview in the panel". The file is
// read again when its folder changes, so an agent writing a doc shows live.
// Derived from Kanso's kanso-panel/preview.js (jlopezlira, Apache-2.0);
// changed for herdr-serhii to follow shared state instead of mount props.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor } from "gpui-base";
import { readTextFile, watchFolder, theme, home, openOverlay, shared } from "herdr";
import { codeState, markdownView, isMarkdown, showPanel, isShown, ICON } from "./lib.js";

const folderOf = (path) => path.replace(/[\\/][^\\/]*$/, "") || "/";
const nameOf = (path) => path.split(/[\\/]/).pop();

export class Preview {
  init() {
    this.path = null; this.on = null;
    this.text = null; this.code = null; this.error = null;
  }

  // Follows shared "serhii.preview"; a new path reads the file and watches its folder.
  follow(cx) {
    const want = shared("serhii.preview") ?? null;
    if (!want?.path || (want.path === this.path && (want.on ?? null) === this.on)) return;
    this.path = want.path; this.on = want.on ?? null;
    this.text = null; this.code?.release(); this.code = null; this.error = null;
    this.load(cx);
    this.watch(cx);
  }

  load(cx) {
    const path = this.path, on = this.on;
    if (!path) return;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(path, { on });
        if (this.path !== path) return;
        if (text === null) { this.error = "This file is no longer available"; this.text = null; }
        else if (text.includes("\0")) { this.error = "Binary file: no text preview"; this.text = null; }
        else {
          this.error = null;
          if (isMarkdown(path)) this.text = text;
          else { this.code?.release(); this.code = codeState(path, text); }
        }
      } catch (e) { if (this.path === path) this.error = `Cannot read this file: ${e?.message ?? e}`; }
      finally { cx.notify(); }
    });
  }

  // Watch the file's folder (this computer only); reread only while shown.
  watch(cx) {
    if (this.on) return;
    const path = this.path, dir = folderOf(path);
    cx.spawn(async (cx) => {
      try {
        while (this.path === path) {
          await watchFolder(dir);
          if (this.path === path && isShown(this.id)) this.load(cx);
        }
      } catch {}
    });
  }

  openWith() {
    openOverlay({ mod: "serhii-open-with", kind: "popup", width: 340, props: { file: this.path, folder: folderOf(this.path), machine: this.on } });
  }

  shortFolder() {
    const dir = folderOf(this.path), h = home();
    if (this.on) return `${this.on}: ${dir}`;
    return dir === h ? "~" : dir.startsWith(h + "/") ? "~" + dir.slice(h.length) : dir;
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    const button = (id, icon, tip, action) => div().id(id).p(4).rounded(6).cursor_pointer().text_color(t.muted).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { action(cx); })
      .child(svg(`${ICON}${icon}.svg`).size(14));
    if (!this.path) {
      return v_flex().id("preview").size_full().bg(t.background).p(16).gap(6).text_size(13)
        .child(div().text_color(t.muted).child("Nothing to preview"))
        .child(div().text_size(12).text_color(t.dim).child("Right-click a file in Files, or open a text file with Cmd+Shift+O, and choose Preview in the panel."));
    }
    return v_flex().id("preview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().font_semibold().child(nameOf(this.path)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.shortFolder()))
        .child(button("preview-open-with", "open-with", "Open with…", () => this.openWith()))
        .child(button("preview-refresh", "refresh", "Read again", (cx) => this.load(cx)))
        .child(button("preview-close", "close", "Close", () => showPanel(null))))
      .child(this.error ? div().p(12).text_color(t.dim).child(this.error)
        : this.text !== null ? markdownView("preview-md", this.text, t)
        : this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child("Reading…"));
  }
}
