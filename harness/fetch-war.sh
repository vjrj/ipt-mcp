#!/usr/bin/env bash
# Download an official IPT release WAR from the GBIF Maven repository.
# repository.gbif.org sometimes cuts a download short (curl 18): retry instead of failing the nightly.
set -euo pipefail
VERSION="${1:-3.3.0}"
OUT="${2:-ipt-$VERSION.war}"
if [ -s "$OUT" ] && unzip -tq "$OUT" >/dev/null 2>&1; then echo "$OUT"; exit 0; fi
mkdir -p "$(dirname "$OUT")"
curl -fsSL --retry 5 --retry-all-errors --retry-delay 15 -o "$OUT.part" "https://repository.gbif.org/repository/releases/org/gbif/ipt/$VERSION/ipt-$VERSION.war"
unzip -tq "$OUT.part" >/dev/null
mv "$OUT.part" "$OUT"
echo "$OUT"
