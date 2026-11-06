#!/bin/sh
# Copies serhii/shared/*.js into every mod that uses them (Herdr mods can't import
# each other's files). Run after editing serhii/shared/; install.sh runs it too.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
for m in serhii-tabs serhii-panel serhii-settings; do
  for f in "$root"/serhii/shared/*.js; do
    cp "$f" "$root/serhii/mods/$m/$(basename "$f")"
  done
done
