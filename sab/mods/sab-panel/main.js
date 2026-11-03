// herdr-sab's right side panel. One mod, five panels chosen by `props.panel`:
// "files" (a lazy file browser with Markdown and code preview), "changes"
// (git status, diffs and a commit), "pr" (pull requests: every open one, with
// checks, threads, reviewers, labels, merge and agent tasks), "issues" (the
// repository's open GitHub issues) and "preview" (one file, chosen with
// shared "sab.preview"). Each is a child of the `panel-body` stack; sab-tabs
// selects one. Panels are derived from Kanso's kanso-panel (Apache-2.0).
import { View } from "gpui-kit";
import { props } from "herdr";
import { Files } from "./files.js";
import { Changes } from "./changes.js";
import { PullRequest } from "./pr.js";
import { Issues } from "./issues.js";
import { Preview } from "./preview.js";

const PANELS = { files: Files, changes: Changes, pr: PullRequest, issues: Issues, preview: Preview };

export default class Panel extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const id = PANELS[p.panel] ? p.panel : "files";
    this.panel = new PANELS[id]();
    this.panel.id = id;
    this.panel.init(cx, p);
  }

  render(cx) {
    return this.panel.render(cx);
  }
}
