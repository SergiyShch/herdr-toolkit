// herdr-sab settings, drawn as Herdr's own Settings window is (frame/settings:
// a 190 px section list on the left, rows of "what it is" and a control, the
// same switch and stepper). Herdr's Settings has a fixed list of sections and
// rewrites itself on every start, so a mod can't add a section there; this is
// its sibling, opened from the tab bar's gear or cmd-alt-, and linking back.
//
// Changes apply at once: it writes ~/.config/herdr-app/sab.json (only what
// differs from the defaults in config.js) and publishes it, so every sab mod
// follows without a reload. Hand edits to the file work too (sab-tabs reads it
// every ~3 s). Task prompts live only in the file (`prompts`).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, knownAgents, appHome, writeTextFile, readTextFile, notify, home, run, shared, setShared } from "herdr";
import { cfg, get, setSetting, resetSettings, DEFAULTS, SETTINGS_FILE } from "./config.js";

const ICON = "mods/sab-panel/icons/";
const SECTIONS = [
  { id: "tabs", title: "Tab bar", icon: `${ICON}sidebar.svg` },
  { id: "panels", title: "Side panels", icon: `${ICON}file.svg` },
  { id: "context", title: "Claude context", icon: `${ICON}chart.svg` },
  { id: "gcloud", title: "gcloud", icon: "icons/gcloud.svg" },
  { id: "github", title: "GitHub", icon: `${ICON}github.svg` },
  { id: "agent", title: "Agent tasks", icon: `${ICON}agent.svg` },
  { id: "pr", title: "Pull requests", icon: `${ICON}pull-request.svg` },
  { id: "issues", title: "Issues", icon: `${ICON}issue.svg` },
];

// Lists typed as text: comma separated paths, space separated args.
const LISTS = {
  "context.cacheRoots": { split: (v) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean), join: (a) => a.join(", "), placeholder: "~/.harp, ~/.local/state/…" },
  "gcloud.loginArgs": { split: (v) => v.trim().split(/\s+/).filter(Boolean), join: (a) => a.join(" "), placeholder: "auth login" },
  // owner=login pairs, comma separated.
  "github.accounts": {
    split: (v) => Object.fromEntries(v.split(/[,\n]/).map((s) => s.split("=").map((x) => x.trim())).filter(([o, l]) => o && l)),
    join: (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join(", "),
    placeholder: "my-org=my-login, other-org=work-login",
    empty: {},
  },
};
const defaultAt = (path) => path.split(".").reduce((v, k) => v?.[k], DEFAULTS);

export default class Settings extends View {
  init(_props, cx) {
    const asked = props()?.section;
    this.section = SECTIONS.some((s) => s.id === asked) ? asked : "tabs";
    this.queue = Promise.resolve();
    this.agents = null;
    this.inputs = {};
    for (const [path, l] of Object.entries(LISTS)) {
      const input = InputState.new({ placeholder: l.placeholder });
      input.set_value(l.join(get(path) ?? []));
      const save = () => {
        const next = l.split(input.value());
        const blank = Array.isArray(next) ? !next.length : !Object.keys(next).length;
        if (JSON.stringify(next) !== JSON.stringify(get(path))) this.set(path, blank ? (l.empty ?? defaultAt(path)) : next);
      };
      input.on("submit", save);
      input.on("blur", save);
      this.inputs[path] = input;
    }
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents()).filter((a) => a.installed); } catch { this.agents = []; }
      cx.notify();
    });
  }

  // Saves one setting; saves run one after another so quick clicks don't race.
  set(path, value) {
    this.queue = this.queue.then(() => setSetting(path, value)).catch((e) =>
      notify({ title: "Could not save sab.json", body: String(e?.message ?? e), level: "error" }));
  }

  close() { closeOverlay(props()?.overlay); }

  async openFile() {
    const path = SETTINGS_FILE();
    if ((await readTextFile(path).catch(() => null)) === null) await writeTextFile(path, "{}\n", null).catch(() => {});
    this.close();
    openOverlay({ mod: "sab-open-with", kind: "popup", at: "top", width: 380, props: { file: path, folder: appHome() } });
  }

  // ---- pieces, as Herdr's Settings draws them ----

  heading(t, text) {
    return div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  row(t, title, about, control, disabled = false) {
    return h_flex().w_full().gap(16).py(12).items_center().border_b(1).border_color(t.border)
      .when(disabled, (el) => el.opacity(0.45))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).text_color(t.foreground).child(title))
        .when(Boolean(about), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about))))
      .child(div().flex_none().child(control));
  }

  button(t, id, label, onClick) {
    return div().id(id).px(12).py(5).rounded(7).border_1().border_color(t.border).bg(t.raised).cursor_pointer()
      .text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  switch(t, id, on, onClick) {
    return div().id(id).w(36).h(20).rounded(10).p(2).cursor_pointer().bg(on ? t.accent : t.hover).flex()
      .when(on, (el) => el.justify_end()).on_click(onClick)
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  toggle(t, path, title, about, disabled = false) {
    const on = Boolean(get(path));
    return this.row(t, title, about, this.switch(t, `set-${path}`, on, () => { if (!disabled) this.set(path, !on); }), disabled);
  }

  stepper(t, path, title, about, { min, max, step, unit = "", disabled = false }) {
    const now = Number(get(path));
    const b = (k, label, next) => div().id(`set-${path}-${k}`).w(28).h(28).flex().items_center().justify_center().cursor_pointer()
      .text_size(15).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => { if (!disabled && next !== now) this.set(path, next); }).child(label);
    const control = h_flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
      .child(b("minus", "−", Math.max(min, now - step)))
      .child(div().w(64).text_size(13).text_color(t.foreground).flex().justify_center().child(`${now}${unit}`))
      .child(b("plus", "+", Math.min(max, now + step)));
    return this.row(t, title, about, control, disabled);
  }

  // A segmented choice, in the look of Herdr's appearance picker.
  choice(t, path, title, about, options, disabled = false) {
    const now = get(path);
    const control = h_flex().rounded(7).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
      .children(options.map(([value, label], i) => {
        const on = JSON.stringify(now) === JSON.stringify(value);
        return div().id(`set-${path}-${i}`).px(10).py(5).cursor_pointer().text_size(13)
          .when(i > 0, (el) => el.border_l(1).border_color(t.border))
          .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => { if (!disabled && !on) this.set(path, value); }).child(label);
      }));
    return this.row(t, title, about, control, disabled);
  }

  text(t, path, title, about, disabled = false) {
    const control = div().w(240).h(30).px(10).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.raised)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(this.inputs[path]).flex_1().h_full().text_size(13).text_color(t.foreground));
    return this.row(t, title, about, control, disabled);
  }

  // ---- pages ----

  tabsPage(t, c) {
    const off = !c.tabs.autoName;
    return v_flex().w_full()
      .child(this.heading(t, "Tab names"))
      .child(this.toggle(t, "tabs.autoName", "Name tabs automatically", "A tab you haven't named shows its issue key or its agent's title. A name you type always wins; an empty name brings the automatic one back."))
      .child(this.toggle(t, "tabs.issueKeyJira", "Jira keys", "WEB-142 from the branch or the folder", off))
      .child(this.toggle(t, "tabs.issueKeyGithub", "GitHub issue numbers", "#123 from a branch like 123-fix or issue-123", off))
      .child(this.toggle(t, "tabs.agentTitle", "Agent's own title", "The title the agent gives its terminal", off))
      .child(div().h(18))
      .child(this.heading(t, "Buttons"))
      .child(this.toggle(t, "tabs.editorButton", "Open in editor", "The button in the tab bar. Cmd+Shift+O works either way."))
      .child(this.toggle(t, "tabs.panelLabels", "Panel button labels", "Off: icons only, with the names in tooltips"));
  }

  panelsPage(t, c) {
    return v_flex().w_full()
      .child(this.heading(t, "Shown in the tab bar"))
      .child(this.toggle(t, "panels.files", "Files", "File tree with Markdown and code preview"))
      .child(this.toggle(t, "panels.changes", "Changes", "git status and diffs of the focused pane's repository"))
      .child(this.toggle(t, "panels.pr", "Pull requests", "Every open one, with checks, threads, reviewers, labels and merge. Reads GitHub with gh while shown."))
      .child(this.toggle(t, "panels.issues", "Issues", "The repository's open issues. Reads GitHub with gh while shown."))
      .child(div().h(18))
      .child(this.heading(t, "Changes"))
      .child(this.toggle(t, "changes.commit", "Commit from the panel", "The message field and Commit button", !c.panels.changes));
  }

  contextPage(t, c) {
    const off = !c.context.enabled;
    return v_flex().w_full()
      .child(this.heading(t, "Claude Code"))
      .child(this.toggle(t, "context.enabled", "Show context on tabs", "How full each Claude Code conversation's context window is, from its status line"))
      .child(this.stepper(t, "context.warnAt", "Warn from", "The figure turns red at this much used", { min: 50, max: 100, step: 5, unit: "%", disabled: off }))
      .child(this.stepper(t, "context.staleMinutes", "Dim after", "An idle agent, or a reading older than this, shows dimmed with its age in the tooltip", { min: 1, max: 120, step: 1, unit: " min", disabled: off }))
      .child(this.text(t, "context.cacheRoots", "Snapshot folders", "Folders where your status line writes claude-statusline.json, comma separated", off));
  }

  gcloudPage(t, c) {
    const off = !c.gcloud.enabled;
    return v_flex().w_full()
      .child(this.heading(t, "Google Cloud CLI"))
      .child(this.toggle(t, "gcloud.enabled", "Show gcloud login", "A chip in the tab bar: green when logged in, red when not or expired; account and project in its tooltip"))
      .child(this.choice(t, "gcloud.label", "Chip shows", null, [["project", "Project"], ["account", "Account"], ["none", "Dot only"]], off))
      .child(this.stepper(t, "gcloud.refreshMinutes", "Check every", null, { min: 1, max: 60, step: 1, unit: " min", disabled: off }))
      .child(this.toggle(t, "gcloud.tokenCheck", "Check the login still works", "Asks gcloud for an access token, which catches an expired session. Uses the network.", off))
      .child(this.stepper(t, "gcloud.tokenCheckMinutes", "Token check every", null, { min: 5, max: 120, step: 5, unit: " min", disabled: off || !c.gcloud.tokenCheck }))
      .child(this.text(t, "gcloud.loginArgs", "Login command", "What the login button runs after gcloud, e.g. auth login --update-adc", off));
  }

  githubPage(t, c) {
    const known = Object.entries(shared("sab.gh.accounts") ?? {});
    return v_flex().w_full()
      .child(this.heading(t, "Accounts"))
      .child(this.toggle(t, "github.autoAccount", "Find the right account", "With several gh logins (gh auth status), the PR and Issues panels use the first one that can see each repository, active one first, and remember it"))
      .child(this.text(t, "github.accounts", "Pin by owner", "owner=login pairs, comma separated. A pin wins over finding."))
      .child(this.row(t, "Remembered", known.length
        ? known.map(([k, v]) => `${k.split("|")[1]} → ${v || "active account"}`).join(" · ")
        : "None yet: an account is remembered the first time a repository is read",
        this.button(t, "set-gh-forget", "Forget", () => setShared("sab.gh.accounts", {})), !known.length));
  }

  agentPage(t, c) {
    const options = [["", "First installed"], ...(this.agents ?? []).slice(0, 4).map((a) => [a.key, a.name])];
    if (c.agent.prefer && !options.some(([k]) => k === c.agent.prefer)) options.push([c.agent.prefer, c.agent.prefer]);
    const custom = Object.keys(c.prompts ?? {}).filter((k) => typeof c.prompts[k] === "string" && c.prompts[k].trim());
    return v_flex().w_full()
      .child(this.heading(t, "Agent"))
      .child(this.choice(t, "agent.prefer", "Start tasks with", "Each task opens a new tab running this agent", options))
      .child(div().h(18))
      .child(this.heading(t, "Tasks"))
      .child(this.toggle(t, "pr.tasks.review", "Code review", "Pull requests: review the diff and report findings"))
      .child(this.toggle(t, "pr.tasks.describe", "Describe change", "Pull requests: draft the description, then update it once you approve"))
      .child(this.toggle(t, "pr.tasks.explain", "Explain it", "Pull requests: walk through what it does"))
      .child(this.toggle(t, "pr.tasks.feedback", "Address feedback", "Pull requests: fix review threads and failing checks"))
      .child(this.toggle(t, "pr.tasks.conflicts", "Resolve conflicts", "Pull requests: shown only when it conflicts"))
      .child(this.toggle(t, "issues.startButton", "Start on an issue", "Issues: work on it in a tab named after the issue"))
      .child(this.row(t, "Prompts", custom.length ? `Your own in sab.json: ${custom.join(", ")}` : "Built-in. Override any in sab.json under \"prompts\": review, describe, explain, feedback, conflicts, issue. Placeholders: {number} {url} {title} {head} {base}.",
        this.button(t, "set-prompts", "Edit sab.json", () => this.openFile())));
  }

  prPage(t, c) {
    const off = !c.panels.pr;
    return v_flex().w_full()
      .child(this.heading(t, "Pull request panel"))
      .child(this.stepper(t, "pr.refreshSeconds", "Read again every", "While shown; every 20 s while a check runs", { min: 30, max: 900, step: 30, unit: " s", disabled: off }))
      .child(this.choice(t, "pr.mergeMethod", "Merge with", null, [["auto", "Repo default"], ["squash", "Squash"], ["merge", "Merge"], ["rebase", "Rebase"]], off))
      .child(this.toggle(t, "pr.rowActions", "Actions on the open list", "Open in browser, Review and Describe on each row", off))
      .child(div().h(18))
      .child(this.heading(t, "Sections"))
      .child(this.toggle(t, "pr.sections.description", "Description", null, off))
      .child(this.toggle(t, "pr.sections.people", "People and labels", "Assignees, reviewers and labels, with pickers", off))
      .child(this.toggle(t, "pr.sections.checks", "Checks", null, off))
      .child(this.toggle(t, "pr.sections.threads", "Unresolved threads", null, off))
      .child(this.toggle(t, "pr.sections.agent", "Ask your agent", "The tasks chosen in Agent tasks", off))
      .child(this.toggle(t, "pr.sections.files", "Files and diffs", null, off));
  }

  issuesPage(t, c) {
    const off = !c.panels.issues;
    return v_flex().w_full()
      .child(this.heading(t, "Issues panel"))
      .child(this.stepper(t, "issues.limit", "Show up to", "The most recently updated open issues", { min: 25, max: 500, step: 25, disabled: off }))
      .child(this.stepper(t, "issues.refreshSeconds", "Read again every", "While shown", { min: 30, max: 900, step: 30, unit: " s", disabled: off }));
  }

  render(cx) {
    const t = theme(), c = cfg();
    const armed = this.armed && Date.now() - this.armed < 4000;
    const nav = v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border)
      .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("herdr-sab"))
      .children(SECTIONS.map((s) => {
        const on = s.id === this.section;
        return h_flex().id(`set-s-${s.id}`).gap(10).px(10).py(7).items_center().rounded(7).cursor_pointer()
          .bg(on ? t.raised : "#00000000").hover((st) => st.bg(t.raised))
          .on_click((_e, cx) => { this.section = s.id; this.handle.focus(); cx.notify(); })
          .child(svg(s.icon).size(15).text_color(on ? t.accent : t.dim))
          .child(div().flex_1().text_size(13.5).text_color(on ? t.foreground : t.muted).child(s.title));
      }))
      .child(div().flex_1())
      .child(v_flex().gap(6).px(4)
        .child(this.button(t, "set-file", "Open sab.json", () => this.openFile()))
        .child(div().id("set-reset").px(12).py(5).rounded(7).cursor_pointer().text_size(13)
          .text_color(armed ? t.ansi1 : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            if (armed) {
              this.armed = 0;
              this.queue = this.queue.then(() => resetSettings()).then(() => {
                for (const [path, l] of Object.entries(LISTS)) this.inputs[path].set_value(l.join(get(path) ?? []));
              }).catch((e) => notify({ title: "Could not reset", body: String(e?.message ?? e), level: "error" }));
            } else this.armed = Date.now();
            cx.notify();
          })
          .child(armed ? "Press again to reset" : "Reset to defaults"))
        .child(div().id("set-herdr").px(12).py(5).rounded(7).cursor_pointer().text_size(13).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => { this.close(); run("app.settings"); }).child("Herdr settings…")));

    const page = { tabs: this.tabsPage, panels: this.panelsPage, context: this.contextPage, gcloud: this.gcloudPage,
      github: this.githubPage, agent: this.agentPage, pr: this.prPage, issues: this.issuesPage }[this.section].call(this, t, c);
    const file = SETTINGS_FILE().startsWith(home()) ? "~" + SETTINGS_FILE().slice(home().length) : SETTINGS_FILE();

    return h_flex().id("sab-settings").track_focus(this.handle).w_full().h(620).min_h(0).items_start().bg(t.popover)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(nav)
      .child(div().relative().flex_1().min_w(0).h_full()
        .child(div().id("set-body").size_full().overflow_y_scroll()
          .child(div().px(28).py(22).child(page)
            .child(div().pt(16).text_size(11.5).text_color(t.dim).child(`Saved to ${file} as you change it.`))))
        .child(Scrollbar.vertical("set-body").mode("always").absolute().inset_0()));
  }
}
