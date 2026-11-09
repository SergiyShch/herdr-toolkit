// The gcloud chip's menu (toolkit-tabs opens it as a popup under the chip, with
// props { panel: "gcloud" }): which gcloud configuration the shown space uses.
// Picking one locks the space to it (gcloud.spaces); then the menu offers only
// "Log in again" and "Unlink". "New configuration…" asks toolkit-tabs to make one
// in a new tab and link it once it has an account (the tab bar outlives this popup).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, run, theme, props, closeOverlay, openOverlay, notify } from "herdr";
import { ICON, G, tokens } from "./lib.js";
import { gcloudConfigs, spaceConfig, linkGcloudSpace } from "./gcloud.js";

export class GcloudMenu {
  init(cx) {
    this.configs = null;
    cx.spawn(async (cx) => { this.configs = await gcloudConfigs(); cx.notify(); });
  }

  close() { closeOverlay(props()?.overlay); }

  link(space, name) {
    linkGcloudSpace(space, name)
      .catch((e) => notify({ title: "Could not save the gcloud configuration", body: String(e?.message ?? e), level: "error" }))
      .finally(() => this.close());
  }

  // Asks the tab bar to do it (gcloud-login, gcloud-new, gcloud-refresh), then closes.
  tell(command) { run(`toolkit-tabs.${command}`); this.close(); }

  render() {
    const c = tokens(theme());
    const space = spaces().find((s) => s.active) ?? null, spaceName = space?.name ?? "this space";
    const linked = spaceConfig(space?.id), list = this.configs ?? [];
    const icon = (name) => div().size(18).flex_none().flex().items_center().justify_center().child(svg(`${ICON}${name}.svg`).size(13).text_color(c.muted));
    const row = (key, lead, title, sub, tail, onClick = null, disabled = false) => h_flex().id(`gcloud-${key}`).w_full().px(8).py(6).gap(10).items_center().rounded(6)
      .when(Boolean(onClick) && !disabled, (el) => el.cursor_pointer().hover((s) => s.bg(c.subtle)).on_click(() => onClick()))
      .when(disabled, (el) => el.opacity(0.5))
      .child(lead)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(c.text).child(title))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(c.dim).child(sub))))
      .child(div().w(14).flex_none().flex().justify_center().text_size(12).text_color(c.text).child(tail ?? ""));
    const about = (cf) => [cf.account ?? "no account", cf.project ?? "no project"].join(" · ");
    const rule = () => div().mx(8).my(4).h(1).bg(c.border);
    let menu = v_flex().id("gcloud-menu").w_full().p(G.xs).gap(1).bg(c.popover)
      .child(div().px(8).pt(6).pb(6).text_size(11).text_color(c.dim).truncate().child(`gcloud for the space ${spaceName}`));
    if (linked) {
      const cf = list.find((x) => x.name === linked);
      menu = menu
        .child(row("linked", icon("lock"), linked, cf ? about(cf) : this.configs ? "gcloud has no such configuration" : "Reading gcloud…", null))
        .child(div().px(8).pb(4).text_size(11).text_color(c.dim).child("Locked to this space. New terminals in it use this configuration."))
        .child(row("login", icon("log-in"), "Log in again…", `gcloud auth login --configuration ${linked}`, null, () => this.tell("gcloud-login")))
        .child(row("unlink", icon("close"), `Unlink from ${spaceName}`, "then pick another configuration", null, () => this.link(space?.id, null)));
    } else {
      const active = list.find((x) => x.active);
      menu = menu
        .children(list.map((cf, i) => row(`c${i}`, icon("server"), cf.name, `${about(cf)}${cf.active ? " · active" : ""}`, null, () => this.link(space?.id, cf.name), !space)))
        .when(!list.length, (el) => el.child(div().px(8).py(6).text_size(11.5).text_color(c.dim).child(this.configs ? "gcloud has no configurations, or isn't installed." : "Reading gcloud configurations…")))
        .child(row("auto", icon("refresh"), "Automatic", active ? `gcloud's active configuration, ${active.name}` : "gcloud's active configuration", "✓"))
        .child(row("new", icon("plus"), "New configuration…", `name, gcloud auth login, project; then locked to ${spaceName}`, null, () => this.tell("gcloud-new"), !space));
    }
    return menu.child(rule())
      .child(row("check", icon("refresh"), "Check again", null, null, () => this.tell("gcloud-refresh")))
      .child(row("settings", icon("settings"), "gcloud settings…", null, null, () => {
        this.close();
        openOverlay({ mod: "toolkit-settings", kind: "dialog", width: 820, height: 620, props: { section: "gcloud" } });
      }));
  }
}
