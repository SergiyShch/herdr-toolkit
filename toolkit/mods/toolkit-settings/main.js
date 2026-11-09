// herdr-toolkit settings, drawn as Herdr's own Settings window is (frame/settings:
// a 190 px section list on the left, rows of "what it is" and a control, the
// same switch and stepper). Herdr's Settings has a fixed list of sections and
// rewrites itself on every start, so a mod can't add a section there; this is
// its sibling, opened from the tab bar's gear or cmd-alt-, and linking back.
//
// Changes apply at once: it writes ~/.config/herdr-app/toolkit.json (only what
// differs from the defaults in config.js) and publishes it, so every toolkit mod
// follows without a reload. Hand edits to the file work too (toolkit-tabs reads it
// every ~3 s). Task prompts live only in the file (`prompts`).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, knownAgents, appHome, writeTextFile, readTextFile, notify, home, run, spaces } from "herdr";
import { cfg, get, setSetting, resetSettings, DEFAULTS, SETTINGS_FILE } from "./config.js";
import { ghLogins, switchGhAccount, addGhAccount, spaceAccount } from "./gh.js";

const ICON = "mods/toolkit-panel/icons/";
const SECTIONS = [
  { id: "tabs", title: "Tab bar", icon: `${ICON}sidebar.svg` },
  { id: "panels", title: "Panels", icon: `${ICON}file.svg` },
  { id: "github", title: "GitHub", icon: `${ICON}github.svg` },
  { id: "agent", title: "Agent tasks", icon: `${ICON}agent.svg` },
  { id: "context", title: "Claude context", icon: `${ICON}chart.svg` },
  { id: "gcloud", title: "gcloud", icon: "icons/gcloud.svg" },
];

// Lists typed as text: comma separated paths, space separated args.
const LISTS = {
  "context.cacheRoots": { split: (v) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean), join: (a) => a.join(", "), placeholder: "~/.harp, ~/.local/state/…" },
  "gcloud.loginArgs": { split: (v) => v.trim().split(/\s+/).filter(Boolean), join: (a) => a.join(" "), placeholder: "auth login" },
  "jira.projects": { split: (v) => v.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean), join: (a) => (a ?? []).join(", "), placeholder: "DS, WEB (empty: any)" },
  "jira.baseUrl": { split: (v) => v.trim(), join: (v) => v ?? "", placeholder: "https://your-site.atlassian.net", empty: "" },
  // owner/name=login pairs; the panels' account menu can remove the shown one.
  "github.repos": {
    split: (v) => Object.fromEntries(v.split(/[,\n]/).map((s) => s.split("=").map((x) => x.trim())).filter(([o, l]) => o.includes("/") && l)),
    join: (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join(", "),
    placeholder: "my-org/app=my-login",
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
    this.readLogins(cx);
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents()).filter((a) => a.installed); } catch { this.agents = []; }
      cx.notify();
    });
  }

  readLogins(cx, fresh = false) {
    cx.spawn(async (cx) => { this.logins = await ghLogins(null, fresh); cx.notify(); });
  }

  // Saves one setting; saves run one after another so quick clicks don't race.
  set(path, value) {
    this.queue = this.queue.then(() => setSetting(path, value)).catch((e) =>
      notify({ title: "Could not save toolkit.json", body: String(e?.message ?? e), level: "error" }));
  }

  close() { closeOverlay(props()?.overlay); }

  async openFile() {
    const path = SETTINGS_FILE();
    if ((await readTextFile(path).catch(() => null)) === null) await writeTextFile(path, "{}\n", null).catch(() => {});
    this.close();
    openOverlay({ mod: "toolkit-open-with", kind: "popup", at: "top", width: 380, props: { file: path, folder: appHome() } });
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

  // A segmented choice, in the look of Herdr's appearance picker. `own` reads and
  // saves the value some other way than by path: { now, pick(value) }.
  choice(t, path, title, about, options, disabled = false, own = null) {
    const now = own ? own.now : get(path);
    const control = h_flex().rounded(7).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
      .children(options.map(([value, label], i) => {
        const on = JSON.stringify(now) === JSON.stringify(value);
        return div().id(`set-${path}-${i}`).px(10).py(5).cursor_pointer().text_size(13)
          .when(i > 0, (el) => el.border_l(1).border_color(t.border))
          .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => { if (!disabled && !on) { if (own) own.pick(value); else this.set(path, value); } }).child(label);
      }));
    return this.row(t, title, about, control, disabled);
  }

  text(t, path, title, about, disabled = false) {
    const control = div().w(240).h(30).px(10).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.raised)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(this.inputs[path]).flex_1().h_full().text_size(13).text_color(t.foreground));
    return this.row(t, title, about, control, disabled);
  }

  // Several on/off settings as one row of chips: each click flips one.
  chips(t, title, about, items, disabled = false) {
    const control = h_flex().flex_wrap().justify_end().gap(6).max_w(340)
      .children(items.map(([path, label]) => {
        const on = get(path) !== false;
        return div().id(`set-${path}`).px(10).py(4).rounded(14).cursor_pointer().text_size(12.5)
          .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised)
          .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => { if (!disabled) this.set(path, !on); }).child(label);
      }));
    return this.row(t, title, about, control, disabled);
  }

  // ---- pages ----

  tabsPage(t, c) {
    const off = !c.tabs.autoName;
    return v_flex().w_full()
      .child(this.heading(t, "Tab names"))
      .child(this.toggle(t, "tabs.autoName", "Name tabs automatically", "A tab you haven't named shows its issue key or its agent's title. A name you type always wins."))
      .child(this.chips(t, "Use", null, [["tabs.issueKeyJira", "Jira keys"], ["tabs.issueKeyGithub", "GitHub #123"], ["tabs.agentTitle", "Agent title"]], off))
      .child(this.toggle(t, "tabs.wrap", "Wrap tabs onto more rows", "Tabs that don't fit start a new row and the bar grows. Off: they scroll sideways."))
      .child(div().h(18))
      .child(this.heading(t, "Jira"))
      .child(this.text(t, "jira.baseUrl", "Jira site", "Every DS-1234 shown (tabs, pull requests, comments, issues, Markdown) links to <site>/browse/DS-1234. ⌘⌥J opens the tab's."))
      .child(this.text(t, "jira.projects", "Projects", "Only these keys count, so UTF-8 and the like never do; lowercase ds-1234 in branch names counts too. Empty: any upper-case key."))
      .child(div().h(18))
      .child(this.heading(t, "Buttons"))
      .child(this.toggle(t, "tabs.finderButton", "Open in Finder", "The focused pane's folder"))
      .child(this.toggle(t, "tabs.editorButton", "Open in editor", "Cmd+Shift+O works either way"))
      .child(this.toggle(t, "tabs.panelLabels", "Labels beside icons", "Off: icons only, names in tooltips"));
  }

  panelsPage(t, c) {
    const pr = !c.panels.pr;
    return v_flex().w_full()
      .child(this.heading(t, "In the tab bar"))
      .child(this.chips(t, "Panels", "GitHub panels read with gh only while shown", [["panels.files", "Files"], ["panels.changes", "Changes"], ["panels.git", "Git"], ["panels.pr", "Pull requests"], ["panels.issues", "Issues"]]))
      .child(this.toggle(t, "changes.commit", "Commit from Changes", "The message field and Commit button", !c.panels.changes))
      .child(this.toggle(t, "changes.createPr", "Create PR from Changes", "Beside Commit, on a branch with commits its base doesn't have: pushes it and runs gh pr create --fill", !c.panels.changes))
      .child(this.toggle(t, "pr.createDraft", "Create pull requests as drafts", "Create PR in the Changes and PR panels", !c.panels.changes && !c.panels.pr))
      .child(this.toggle(t, "changes.nested", "Repositories in subfolders", "A folder that is not a repository shows the changes of each one inside it, with a filter per repository", !c.panels.changes))
      .child(this.stepper(t, "changes.scanDepth", "Look for them", "Folders deep, below the pane's folder", { min: 1, max: 5, step: 1, unit: " deep", disabled: !c.panels.changes || !c.changes.nested }))
      .child(div().h(18))
      .child(this.heading(t, "Git"))
      .child(this.stepper(t, "git.graphLimit", "Graph shows", "The latest commits, of every branch or only the checked-out one", { min: 100, max: 2000, step: 100, unit: " commits", disabled: !c.panels.git }))
      .child(div().h(18))
      .child(this.heading(t, "Pull requests"))
      .child(this.chips(t, "Sections", null, [["pr.sections.description", "Description"], ["pr.sections.people", "People"], ["pr.sections.checks", "Checks"],
        ["pr.sections.threads", "Threads"], ["pr.sections.comments", "Comments"], ["pr.sections.agent", "Agent"], ["pr.sections.files", "Files"]], pr))
      .child(this.choice(t, "pr.mergeMethod", "Merge with", null, [["auto", "Repo default"], ["squash", "Squash"], ["merge", "Merge"], ["rebase", "Rebase"]], pr))
      .child(this.toggle(t, "pr.rowActions", "Actions on the open list", "Open in browser, Review and Describe on each row", pr))
      .child(div().h(18))
      .child(this.heading(t, "Issues"))
      .child(this.stepper(t, "issues.limit", "Show up to", "The most recently updated open issues", { min: 25, max: 500, step: 25, disabled: !c.panels.issues }));
  }

  contextPage(t, c) {
    const off = !c.context.enabled;
    return v_flex().w_full()
      .child(this.heading(t, "Claude Code"))
      .child(this.toggle(t, "context.enabled", "Show context on tabs", "How full each Claude Code conversation's context window is, from its status line. Idle ones show dimmed."))
      .child(this.stepper(t, "context.warnAt", "Warn from", "The figure turns red at this much used", { min: 50, max: 100, step: 5, unit: "%", disabled: off }))
      .child(this.text(t, "context.cacheRoots", "Snapshot folders", "Where your status line writes claude-statusline.json, comma separated", off));
  }

  gcloudPage(t, c) {
    const off = !c.gcloud.enabled;
    return v_flex().w_full()
      .child(this.heading(t, "Google Cloud CLI"))
      .child(this.toggle(t, "gcloud.enabled", "Show gcloud login", "A chip in the tab bar: green when logged in, red when not or expired"))
      .child(this.choice(t, "gcloud.label", "Chip shows", null, [["project", "Project"], ["account", "Account"], ["none", "Dot only"]], off))
      .child(this.toggle(t, "gcloud.tokenCheck", "Catch an expired login", "Asks gcloud for an access token now and then. Uses the network.", off))
      .child(this.text(t, "gcloud.loginArgs", "Login command", "What the login button runs after gcloud, e.g. auth login --update-adc", off));
  }

  githubPage(t, c) {
    const list = this.logins ?? [];
    return v_flex().w_full()
      .child(this.heading(t, "Logged in to gh"))
      .when(!this.logins, (el) => el.child(this.row(t, "Reading gh auth status…", null, div())))
      .when(Boolean(this.logins) && !list.length, (el) => el.child(this.row(t, "No account", "gh isn't logged in, or isn't installed.", div())))
      .children(list.map((l, i) => this.row(t, l.login,
        [l.active ? "Active: what gh uses in your terminals" : null, l.host !== "github.com" ? l.host : null, l.ok ? null : "login broken: add it again"].filter(Boolean).join(" · ") || null,
        l.active ? div().px(10).text_size(12.5).text_color(t.accent).child("Active")
          : this.button(t, `set-gh-switch-${i}`, this.switching === l.login ? "Switching…" : "Make active", (_e, cx) => {
            if (this.switching) return;
            this.switching = l.login; cx.notify();
            switchGhAccount(l.login, l.host).catch((e) => notify({ title: "Could not switch gh account", body: String(e?.message ?? e), level: "error" }))
              .finally(() => { this.switching = null; this.readLogins(cx, true); });
          }))))
      .child(this.row(t, "Add an account", "gh auth login, in a new tab", this.button(t, "set-gh-add", "Add…", () => { this.close(); addGhAccount(); })))
      .child(div().h(18))
      .child(this.heading(t, "Account for each space"))
      .child(div().pb(6).text_size(12.5).line_height("18px").text_color(t.dim)
        .child("The PR and Issues panels read GitHub as the space's account. The account menu in their header links the space you're in."))
      .children(this.spaceRows(t, list))
      .child(div().h(18))
      .child(this.heading(t, "Which account reads a repository"))
      .child(this.toggle(t, "github.autoAccount", "Find it automatically", "The PR and Issues panels use the first account that can see the repository, active one first"))
      .child(this.text(t, "github.repos", "Pinned", "owner/name=login pairs. A repository's pin wins over its space's account."));
  }

  // One row per space on this computer, plus links to spaces that are gone.
  spaceRows(t, list) {
    const links = get("github.spaces") ?? {};
    const save = (id, login) => {
      const next = { ...(get("github.spaces") ?? {}) };
      if (login) next[id] = login; else delete next[id];
      this.set("github.spaces", next);
    };
    const here = spaces().filter((s) => !s.machine);
    const gone = Object.keys(links).filter((id) => !spaces().some((s) => s.id === id));
    const logins = list.filter((l) => l.ok).map((l) => l.login);
    return [
      ...here.map((s, i) => {
        const now = spaceAccount(s.id), title = `${s.name}${s.active ? " · this space" : ""}`;
        // Linked: locked to its login until it is unlinked.
        if (now) return this.row(t, title, `Locked to ${now}${logins.includes(now) ? "" : " (not logged in)"}`,
          h_flex().gap(10).items_center()
            .child(svg(`${ICON}lock.svg`).size(13).text_color(t.dim))
            .child(this.button(t, `set-gh-unlink-${i}`, "Unlink", () => save(s.id, null))));
        return this.choice(t, `github.spaces.${s.id}`, title, "The first account that can see each repository",
          [["", "Automatic"], ...logins.map((l) => [l, l])], false, { now: "", pick: (v) => save(s.id, v) });
      }),
      ...gone.map((id, i) => this.row(t, "A space that's closed", `Linked to ${links[id]}`,
        this.button(t, `set-gh-gone-${i}`, "Unlink", () => save(id, null)))),
    ];
  }

  agentPage(t, c) {
    const options = [["", "First installed"], ...(this.agents ?? []).slice(0, 4).map((a) => [a.key, a.name])];
    if (c.agent.prefer && !options.some(([k]) => k === c.agent.prefer)) options.push([c.agent.prefer, c.agent.prefer]);
    const custom = Object.keys(c.prompts ?? {}).filter((k) => typeof c.prompts[k] === "string" && c.prompts[k].trim());
    return v_flex().w_full()
      .child(this.heading(t, "Agent"))
      .child(this.choice(t, "agent.prefer", "Start tasks with", "Each task opens a new tab running this agent", options))
      .child(this.chips(t, "Tasks", "Buttons in the PR and Issues panels", [["pr.tasks.review", "Code review"], ["pr.tasks.describe", "Describe change"], ["pr.tasks.explain", "Explain"],
        ["pr.tasks.feedback", "Address feedback"], ["pr.tasks.conflicts", "Resolve conflicts"], ["issues.startButton", "Start on issue"]]))
      .child(this.row(t, "Prompts", custom.length ? `Your own in toolkit.json: ${custom.join(", ")}` : "Built-in. Override any in toolkit.json under \"prompts\".",
        this.button(t, "set-prompts", "Edit toolkit.json", () => this.openFile())));
  }

  render(cx) {
    const t = theme(), c = cfg();
    const armed = this.armed && Date.now() - this.armed < 4000;
    const nav = v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border)
      .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("herdr-toolkit"))
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
        .child(this.button(t, "set-file", "Open toolkit.json", () => this.openFile()))
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
      github: this.githubPage, agent: this.agentPage }[this.section].call(this, t, c);
    const file = SETTINGS_FILE().startsWith(home()) ? "~" + SETTINGS_FILE().slice(home().length) : SETTINGS_FILE();

    return h_flex().id("toolkit-settings").track_focus(this.handle).w_full().h(620).min_h(0).items_start().bg(t.popover)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(nav)
      .child(div().relative().flex_1().min_w(0).h_full()
        .child(div().id("set-body").size_full().overflow_y_scroll()
          .child(div().px(28).py(22).child(page)
            .child(div().pt(16).text_size(11.5).text_color(t.dim).child(`Saved to ${file} as you change it.`))))
        .child(Scrollbar.vertical("set-body").mode("always").absolute().inset_0()));
  }
}
