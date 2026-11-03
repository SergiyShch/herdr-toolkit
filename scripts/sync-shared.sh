#!/bin/sh
# Copies sab/shared/*.js into every mod that uses them (Herdr mods can't import
# each other's files). Run after editing sab/shared/; install.sh runs it too.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
for m in sab-tabs sab-panel sab-settings; do
  for f in "$root"/sab/shared/*.js; do
    cp "$f" "$root/sab/mods/$m/$(basename "$f")"
  done
done
