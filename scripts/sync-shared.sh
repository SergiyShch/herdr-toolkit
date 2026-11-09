#!/bin/sh
# Copies toolkit/shared/*.js into every mod that uses them (Herdr mods can't import
# each other's files). Run after editing toolkit/shared/; install.sh runs it too.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
for m in toolkit-tabs toolkit-panel toolkit-settings; do
  for f in "$root"/toolkit/shared/*.js; do
    cp "$f" "$root/toolkit/mods/$m/$(basename "$f")"
  done
done
