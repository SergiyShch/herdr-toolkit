// herdr-sab's tab bar. Derived from the `tabs` mod shipped with Herdr
// (Apache-2.0); ideas from Kanso (jlopezlira/herdr-kanso) and Mission Control
// (CiprianSpiridon/herdr-mission-control). Left to right:
//
// - Tabs that name themselves: a tab nobody named shows the issue key its
//   branch or folder carries (WEB-142, #123), else its agent's own title, else
//   the program. A name you type (double-click, F2) always wins; an empty name
//   brings the automatic one back. Nothing is written: the name is only drawn.
// - Claude Code's context: a Claude Code tab shows how full its context window
//   is, from the status line snapshot (context.js). An idle agent keeps its last
//   reading, dimmed, with its age in the tooltip.
// - + opens the shipped new-menu.
// - gcloud: who is logged in (dot: green yes, red no or expired), the project
//   in the chip, account and project in the tooltip; the small button beside it
//   runs `gcloud auth login` in a new tab (also cmd-alt-g).
// - Open in editor (cmd-shift-o): the sab-open-with popup for the focused pane.
// - Panel buttons: Files, Changes, PR, Issues toggle the right side panel
//   (`panel` / `panel-body` in layouts/sab.json); remembered per space.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, layout, settings, exec, focused, nextCommand } from "herdr";
import { ClaudeContext, cleanTitle } from "./context.js";
import { cfg, readSettings, SHARED_KEY, jiraKey, jiraUrl } from "./config.js";
import { shared, setShared, notify } from "herdr";

const ICON = "mods/sab-panel/icons/";
const PANELS = [
  { id: "files", label: "Files", icon: "file" },
  { id: "changes", label: "Changes", icon: "changes" },
  { id: "pr", label: "PR", icon: "pull-request" },
  { id: "issues", label: "Issues", icon: "issue" },
];
// Panels switched on in settings; Preview always (it opens from Open with).
const enabledPanels = () => [...PANELS.filter((p) => cfg().panels[p.id] !== false).map((p) => p.id), "preview"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// ---- Automatic tab names ----------------------------------------------------------

// A Jira-style key (WEB-142) anywhere, or a GitHub issue number a branch starts
// with or names ("123-fix", "fix/123-login", "issue-123").
export function issueKey(text, { jira = true, github = true } = {}) {
  const s = String(text ?? "");
  const j = jira && jiraKey(s);
  if (j) return j;
  const gh = github && /(?:^|\/)(?:issue-|issues-|gh-)?(\d{1,6})(?=[-_]|$)/i.exec(s);
  return gh ? `#${gh[1]}` : null;
}

const GENERIC = /^(claude( code)?|codex|grok|gemini|opencode|zsh|bash|fish|sh|nu|pwsh|node|python3?|~|[~/].*|\d+)$/i;

export function autoName(tab, tabPanes, o = cfg().tabs) {
  if (tab.named) return { name: tab.name, full: tab.name };
  const agent = tabPanes.find((p) => p.program?.agent) ?? null;
  const first = agent ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  // Automatic names off: Herdr's own (the program, as the shipped tab bar shows).
  if (!o.autoName) return { name: first?.program?.name ?? tab.name, full: tab.name };
  const folder = first?.cwd?.split(/[\\/]/).pop();
  const keys = { jira: o.issueKeyJira, github: o.issueKeyGithub };
  const key = issueKey(first?.branch, keys) ?? issueKey(folder, keys);
  const title = o.agentTitle ? cleanTitle(agent?.title ?? first?.title) : "";
  const usable = title && !GENERIC.test(title) && title !== first?.program?.name ? title : null;
  const name = key ?? usable ?? first?.program?.name ?? "Terminal";
  return { name, full: [key, usable].filter(Boolean).join(" · ") || name };
}

// The Jira ticket a tab is about: from its name, its branch or its folder.
export function tabJira(tab, tabPanes) {
  const first = tabPanes.find((p) => p.program?.agent) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  return jiraKey(tab.named ? tab.name : "") ?? jiraKey(first?.branch) ?? jiraKey(first?.cwd?.split(/[\\/]/).pop());
}

const isClaude = (p) => p?.app === "claude-code" || p?.program?.key === "claude";

function age(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    this.gcloud = { state: "loading" };

    // Settings file and Claude Code context readings: every 3 s, redraw only on a change.
    this.ctx = new ClaudeContext();
    const tick = (cx) => cx.spawn(async (cx) => {
      await this.syncSettings();
      if (cfg().context.enabled && await this.ctx.poll(cfg().context.cacheRoots)) cx.notify();
    });
    tick(cx);
    cx.timer.every(3000, tick);
    // Ages in tooltips and the stale dimming move slowly: once a minute is enough.
    cx.timer.every(60000, (cx) => cx.notify());

    // gcloud: every refreshMinutes; every 10 s for 3 min after a login was started.
    this.gcloudRefresh(cx, true);
    cx.timer.every(10000, (cx) => {
      const g = cfg().gcloud;
      if (!g.enabled) return;
      const fast = this.loginAt && Date.now() - this.loginAt < 180000;
      const tokenDue = g.tokenCheck && Date.now() - (this.gcloud.tokenAt ?? 0) > g.tokenCheckMinutes * 60000;
      if (fast || Date.now() - (this.gcloud.at ?? 0) > g.refreshMinutes * 60000) this.gcloudRefresh(cx, fast || tokenDue);
    });

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "gcloud-login") this.gcloudLogin();
        if (c === "gcloud-refresh") this.gcloudRefresh(cx, true);
        if (c === "jira-open") this.openJira();
        cx.notify();
      }
    });
  }

  // ---- settings ----

  // Publishes ~/.config/herdr-app/sab.json as shared "sab.settings" when it changes.
  // A broken file keeps the last good settings and says so once.
  async syncSettings() {
    try {
      const { text, value } = await readSettings();
      if (text === this.settingsText) return;
      this.settingsText = text; this.settingsError = null;
      if (JSON.stringify(shared(SHARED_KEY) ?? {}) !== JSON.stringify(value)) setShared(SHARED_KEY, value);
    } catch (e) {
      const why = String(e?.message ?? e);
      if (why !== this.settingsError) notify({ title: "sab.json could not be read", body: `${why}. Keeping the last good settings.`, level: "warning" });
      this.settingsError = why;
    }
  }

  // ---- gcloud ----

  // Account and project from the active configuration; `token`: also ask for an
  // access token (catches an expired or revoked login; uses the network).
  gcloudRefresh(cx, token = false) {
    if (this.gcloudBusy || !cfg().gcloud.enabled) return;
    this.gcloudBusy = true;
    cx.spawn(async (cx) => {
      const next = { at: Date.now(), tokenAt: this.gcloud.tokenAt, tokenOk: this.gcloud.tokenOk };
      try {
        const r = await exec("gcloud", ["config", "list", "--format=json"]).catch(() => null);
        if (!r) { next.state = "missing"; return; }
        if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n")[0] || "gcloud failed");
        const core = JSON.parse(r.stdout || "{}").core ?? {};
        next.account = core.account ?? null; next.project = core.project ?? null;
        const list = await exec("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
        next.active = list.code === 0 ? list.stdout.trim() || null : null;
        if (token && next.active && cfg().gcloud.tokenCheck) {
          const t = await exec("gcloud", ["auth", "print-access-token", "--verbosity=none"]).catch(() => ({ code: 1 }));
          next.tokenOk = t.code === 0; next.tokenAt = Date.now();
        }
        if (!next.active) next.tokenOk = false;
        if (!cfg().gcloud.tokenCheck) next.tokenOk = undefined;
        next.state = !next.active ? "out" : next.tokenOk === false ? "expired" : "in";
      } catch (e) {
        next.state = "error";
        next.error = String(e?.message ?? e);
      } finally {
        this.gcloud = next; this.gcloudBusy = false; cx.notify();
      }
    });
  }

  // The focused pane's folder and the machine it is on (null: this computer).
  paneFolder(space, allPanes) {
    const f = focused(), pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : allPanes.find((p) => p.focused);
    const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
    return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
  }

  // Opens the focused tab's Jira ticket (cmd-alt-j).
  openJira() {
    const space = spaces().find((s) => s.active), tab = space?.tabs?.find((t) => t.active);
    const key = tab ? tabJira(tab, panes().filter((p) => p.tab === tab.id)) : null, url = jiraUrl(key);
    if (url) exec("open", [url]).catch(() => {});
    else notify({ title: key ? "No Jira site set" : "No Jira key on this tab", body: key ? "Set it in herdr-sab settings → Tab bar → Jira site." : "The tab's name, branch or folder carries none (like DS-1234)." });
  }

  gcloudLogin() {
    this.loginAt = Date.now();
    this.gcloud = { ...this.gcloud, tokenAt: 0 };
    const space = spaces().find((s) => s.active);
    const args = cfg().gcloud.loginArgs;
    run("tab.new", { name: "gcloud login", space: space?.id, argv: ["gcloud", ...(Array.isArray(args) && args.length ? args : ["auth", "login"])] });
  }

  gcloudChip(t, stop) {
    const g = this.gcloud;
    const o = cfg().gcloud;
    if (!o.enabled || g.state === "missing") return null;
    const color = g.state === "in" ? t.ansi2 : g.state === "loading" ? t.dim : t.ansi1;
    const label = o.label === "none" ? null : o.label === "account" ? (g.active ?? g.account ?? "not logged in") : (g.project ?? (g.state === "loading" ? "gcloud" : "no project"));
    const tip = g.state === "loading" ? "gcloud: checking…"
      : g.state === "error" ? `gcloud: ${g.error}`
      : [g.state === "in" ? `Logged in as ${g.active}` : g.state === "expired" ? `${g.active}: the login expired, log in again` : "Not logged in to gcloud",
        `Project: ${g.project ?? "none set"}`, g.account && g.account !== g.active ? `Configured account: ${g.account}` : null,
        g.at ? `Checked ${age(g.at)} · click to check again` : null].filter(Boolean).join("\n");
    const loginTip = g.state === "in" ? "gcloud auth login (switch account)" : "Log in: gcloud auth login";
    return h_flex().flex_none().items_center().gap(1)
      .child(h_flex().id("gcloud-chip").h(26).pl(7).pr(8).gap(6).items_center().rounded(6).text_size(11.5).text_color(t.muted)
        .tooltip(tip).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => this.gcloudRefresh(cx, true))
        .child(svg("icons/gcloud.svg").size(13).text_color(t.muted))
        .child(div().size(6).flex_none().rounded_full().bg(color))
        .when(Boolean(label), (el) => el.child(div().max_w(150).truncate().child(label))))
      .child(div().id("gcloud-login").size(22).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(g.state === "in" ? t.dim : t.ansi1).tooltip(loginTip)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => this.gcloudLogin())
        .child(svg(`${ICON}log-in.svg`).size(13)));
  }

  // ---- side panel, remembered per space (as the shipped tabs mod) ----

  syncPanel(space, panel, body) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabledPanels().includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    try { localStorage.setItem("panels", JSON.stringify(this.panels)); } catch {}
  }

  // ---- drawing ----

  contextChip(tab, tabPanes, claudePanes, t) {
    const o = cfg().context;
    if (!o.enabled) return null;
    const pane = tabPanes.find(isClaude);
    if (!pane) return null;
    const r = this.ctx.forPane(pane, claudePanes);
    if (!r) return null;
    const idle = pane.status !== "working" && pane.status !== "blocked";
    const stale = idle || Date.now() - r.at > o.staleMinutes * 60000;
    const hot = r.pct >= o.warnAt;
    const tip = [`Context ${r.pct}% used, ${Math.max(0, 100 - r.pct)}% left`,
      r.size ? `of ${Math.round(r.size / 1000)}k tokens` : null, r.model, `${stale ? "last reading" : "updated"} ${age(r.at)}`]
      .filter(Boolean).join(" · ");
    return div().id(`ctx-${tab.id}`).flex_none().px(5).h(16).flex().items_center().rounded(4)
      .bg((hot ? t.blocked : t.foreground) + "14").text_size(10.5)
      .text_color(hot ? t.blocked : t.muted).when(stale, (el) => el.opacity(0.55))
      .tooltip(tip).child(`${r.pct}%`);
  }

  render() {
    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const allPanes = panes();
    const claudePanes = allPanes.filter(isClaude);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action)
      .when(Boolean(tip), (el) => el.tooltip(tip)).child(label);

    const item = (c, i) => {
      const tabPanes = allPanes.filter((p) => p.tab === c.id);
      const program = tabPanes.find((p) => p.program?.agent)?.program ?? tabPanes[0]?.program;
      const { name, full } = autoName(c, tabPanes);
      const jira = jiraUrl(tabJira(c, tabPanes)), jk = jira ? tabJira(c, tabPanes) : null;
      const working = c.status === "working";
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .tooltip([full, c.named ? null : "Double-click to name it", jk ? `${jk} in Jira: ⌘⌥J` : null].filter(Boolean).join("\n"))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(190).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(working, (el) => el.child(div().size(6).flex_none().rounded_full().bg(t.working).loop("opacity", { from: 0.3, to: 1, period: 1400 })))
        .when(c.status === "blocked" || c.status === "done", (el) => el.child(div().size(6).flex_none().rounded_full().bg(t[c.status])))
        .when(true, (el) => { const chip = this.contextChip(c, tabPanes, claudePanes, t); return chip ? el.child(chip) : el; })
        .when(Boolean(jira) && c.active, (el) => el.child(div().id(`jira-${c.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Open ${jk} in Jira  ⌘⌥J`)
          .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); exec("open", [jira]).catch(() => {}); })
          .child(svg(`${ICON}ticket.svg`).size(13))))
        .when(c.active && shown.length > 1, (el) => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg(`${ICON}close.svg`).size(12))));
    };

    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    this.syncPanel(space, panel, body);

    const o = cfg();
    const labels = o.tabs.panelLabels;
    // A panel switched off while shown closes.
    if (panel && !panel.hidden && body?.active && !enabledPanels().includes(body.active)) run("layout.hide", { id: "panel" });
    const panelButton = ({ id, label, icon }) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).when(!labels, (el) => el.tooltip(label)).child(svg(`${ICON}${icon}.svg`).size(14)).when(labels, (el) => el.child(label));
    };
    const hasPane = Boolean(focused()?.cwd || allPanes.some((p) => p.focused && p.cwd));
    const editor = h_flex().id("open-editor").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .text_color(hasPane ? t.muted : t.dim).tooltip("Open the pane's folder in an editor  ⌘⇧O")
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click(() => openOverlay({ mod: "sab-open-with", kind: "popup", at: "top", width: 380 }))
      .child(svg(`${ICON}code.svg`).size(14)).when(labels, (el) => el.child("Editor"));
    // The focused pane's folder in Finder; a pane on another machine has none here.
    const where = this.paneFolder(space, allPanes);
    const finder = div().id("open-finder").size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(where.cwd && !where.on ? t.muted : t.dim)
      .tooltip(!where.cwd ? "Open in Finder: focus a pane first" : where.on ? `Open in Finder: the pane is on ${where.on}` : `Open in Finder\n${where.cwd}`)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click(() => { if (where.cwd && !where.on) exec("open", [where.cwd]).catch(() => {}); })
      .child(svg(`${ICON}finder.svg`).size(15));
    const sep = () => div().w(1).h(16).mx(4).flex_none().bg(t.border);
    const gcloud = this.gcloudChip(t, stop);

    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", svg(`${ICON}plus.svg`).size(15), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New tab"))
      .child(sep())
      .when(Boolean(gcloud), (el) => el.child(gcloud).when(o.tabs.editorButton || o.tabs.finderButton || PANELS.some((p) => o.panels[p.id] !== false), (el) => el.child(sep())))
      .when(o.tabs.finderButton, (el) => el.child(finder))
      .when(o.tabs.editorButton, (el) => el.child(editor))
      .children(PANELS.filter((p) => o.panels[p.id] !== false).map(panelButton))
      .child(button("sab-settings", svg(`${ICON}settings.svg`).size(14), () => openOverlay({ mod: "sab-settings", kind: "dialog", width: 820, height: 620 }), "herdr-sab settings  ⌘⌥,"))
      .when(Boolean(w?.buttons), (el) => el
        .child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", svg(`${ICON}close.svg`).size(13), () => run("window.close"))));
  }
}
