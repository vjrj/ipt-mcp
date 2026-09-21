#!/usr/bin/env bash
# Download an official IPT release WAR from the GBIF Maven repository.
set -euo pipefail
VERSION="${1:-3.3.0}"
OUT="${2:-ipt-$VERSION.war}"
curl -fsSL -o "$OUT" "https://repository.gbif.org/repository/releases/org/gbif/ipt/$VERSION/ipt-$VERSION.war"
echo "$OUT"
