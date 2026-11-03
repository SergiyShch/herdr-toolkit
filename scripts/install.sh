#!/bin/sh
# Installs (or removes) the herdr-sab layout and mods into the Herdr app home.
#   scripts/install.sh            install, or update files this script installed before
#   scripts/install.sh --dry-run  show what it would do
#   scripts/install.sh --remove   remove the layout, the mods and the keys it added
# HERDR_APP_HOME picks another app home (default ~/.config/herdr-app).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
src="$here/sab"
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mods="sab-tabs sab-panel sab-open-with sab-settings sab-chrome"
mode=install
case "${1:-}" in
  --dry-run) mode=dry ;;
  --remove|--uninstall) mode=remove ;;
  "") ;;
  *) echo "usage: $0 [--dry-run|--remove]" >&2; exit 2 ;;
esac
[ -d "$dest" ] || { echo "No Herdr app home at $dest" >&2; exit 1; }

run() { if [ "$mode" = dry ]; then echo "would: $*"; else "$@"; fi; }

merge_keys() { # $1 = add | remove
  python3 - "$dest/keys.json" "$src/keys.json" "$1" "$mode" <<'PY'
import json, sys, os
path, ours, action, mode = sys.argv[1:5]
mine = json.load(open(ours))
cur = json.load(open(path)) if os.path.exists(path) else {}
changed = False
for section, keys in mine.items():
    have = cur.setdefault(section, {})
    for k, v in keys.items():
        if action == "add":
            if k in have and have[k] != v:
                print(f"keys.json: {section} {k} is already {have[k]!r}; left as is")
            elif k not in have:
                have[k] = v; changed = True; print(f"keys.json: + {section} {k} -> {v}")
        elif have.get(k) == v:
            del have[k]; changed = True; print(f"keys.json: - {section} {k}")
    if not have: del cur[section]
if changed and mode != "dry":
    tmp = path + ".sab-tmp"
    json.dump(cur, open(tmp, "w"), indent=2); os.replace(tmp, path)
PY
}

if [ "$mode" = remove ]; then
  run rm -f "$dest/layouts/sab.json"
  for m in $mods; do [ -f "$dest/mods/$m/.herdr-sab" ] && run rm -rf "$dest/mods/$m"; done
  merge_keys remove
  echo "Removed. Switch layouts with ctrl-shift-l if Herdr still shows sab."
  exit 0
fi

# Never overwrite something this script did not install.
for m in $mods; do
  if [ -d "$dest/mods/$m" ] && [ ! -f "$dest/mods/$m/.herdr-sab" ]; then
    echo "mods/$m exists and was not installed by herdr-sab; not touching it" >&2; exit 1
  fi
done
if [ -f "$dest/layouts/sab.json" ] && ! grep -q '"sab-tabs"' "$dest/layouts/sab.json"; then
  echo "layouts/sab.json exists and is not herdr-sab's; not touching it" >&2; exit 1
fi

"$here/scripts/sync-shared.sh"
run cp "$src/layouts/sab.json" "$dest/layouts/sab.json"
for m in $mods; do
  run mkdir -p "$dest/mods/$m"
  run cp -R "$src/mods/$m/." "$dest/mods/$m/"
  run touch "$dest/mods/$m/.herdr-sab"
done
merge_keys add
if [ "$mode" != dry ] && command -v herdr-app >/dev/null 2>&1; then
  for m in $mods; do herdr-app check "$dest/mods/$m"; done
  echo "Installed. Switch to it: herdr-app do layout.switch --name sab   (ctrl-shift-l goes back)"
fi
