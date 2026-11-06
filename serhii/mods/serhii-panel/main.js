// herdr-serhii's right side panel. One mod, five panels chosen by `props.panel`:
// "files" (a lazy file browser with Markdown and code preview), "changes"
// (git status, diffs and a commit), "pr" (pull requests: every open one, with
// checks, threads, reviewers, labels, merge and agent tasks), "issues" (the
// repository's open GitHub issues) and "preview" (one file, chosen with
// shared "serhii.preview"). Each is a child of the `panel-body` stack; serhii-tabs
// selects one. A sixth, "diff", is not in the stack: the Changes panel opens it
// as a dialog (a file's last commit and working tree side by side).
// Panels are derived from Kanso's kanso-panel (Apache-2.0).
import { View } from "gpui-kit";
import { props } from "herdr";
import { Files } from "./files.js";
import { Changes } from "./changes.js";
import { PullRequest } from "./pr.js";
import { Issues } from "./issues.js";
import { Preview } from "./preview.js";
import { Diff } from "./diff.js";

const PANELS = { files: Files, changes: Changes, pr: PullRequest, issues: Issues, preview: Preview, diff: Diff };

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

  async close(cx) {
    await this.panel.close?.(cx);
  }
}
