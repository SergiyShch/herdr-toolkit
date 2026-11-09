#!/bin/sh
# Installs (or removes) the herdr-toolkit layout and mods into the Herdr app home.
#   scripts/install.sh            install, or update files this script installed before
#   scripts/install.sh --dry-run  show what it would do
#   scripts/install.sh --remove   remove the layout, the mods and the keys it added
# HERDR_APP_HOME picks another app home (default ~/.config/herdr-app).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
src="$here/toolkit"
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mods="toolkit-tabs toolkit-panel toolkit-open-with toolkit-settings toolkit-chrome"
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
    tmp = path + ".toolkit-tmp"
    json.dump(cur, open(tmp, "w"), indent=2); os.replace(tmp, path)
PY
}

if [ "$mode" = remove ]; then
  run rm -f "$dest/layouts/toolkit.json"
  for m in $mods; do [ -f "$dest/mods/$m/.herdr-toolkit" ] && run rm -rf "$dest/mods/$m"; done
  merge_keys remove
  echo "Removed. Switch layouts with ctrl-shift-l if Herdr still shows toolkit."
  exit 0
fi

# Never overwrite something this script did not install.
for m in $mods; do
  if [ -d "$dest/mods/$m" ] && [ ! -f "$dest/mods/$m/.herdr-toolkit" ]; then
    echo "mods/$m exists and was not installed by herdr-toolkit; not touching it" >&2; exit 1
  fi
done
if [ -f "$dest/layouts/toolkit.json" ] && ! grep -q '"toolkit-tabs"' "$dest/layouts/toolkit.json"; then
  echo "layouts/toolkit.json exists and is not herdr-toolkit's; not touching it" >&2; exit 1
fi

"$here/scripts/sync-shared.sh"
run cp "$src/layouts/toolkit.json" "$dest/layouts/toolkit.json"
for m in $mods; do
  run mkdir -p "$dest/mods/$m"
  run cp -R "$src/mods/$m/." "$dest/mods/$m/"
  run touch "$dest/mods/$m/.herdr-toolkit"
done
merge_keys add
if [ "$mode" != dry ] && command -v herdr-app >/dev/null 2>&1; then
  for m in $mods; do herdr-app check "$dest/mods/$m"; done
  echo "Installed. Switch to it: herdr-app do layout.switch --name toolkit   (ctrl-shift-l goes back)"
fi
