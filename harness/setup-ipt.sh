#!/usr/bin/env bash
# Run the IPT installation wizard (data dir, admin user, TEST mode, public URL) against a fresh IPT.
# TEST mode keeps the IPT away from the production GBIF registry.
set -euo pipefail
BASE="${IPT_TEST_URL:-http://localhost:18080/ipt}"
EMAIL="${IPT_TEST_EMAIL:-admin@example.org}"
PASSWORD="${IPT_TEST_PASSWORD:-Passw0rd-test}"
JAR="$(mktemp)"
post() { curl -fsS -m 300 -b "$JAR" -c "$JAR" -o /dev/null -w "%{http_code} %{url_effective}\n" "$@"; }
post -X POST "$BASE/setupDataDirectory.do" -d dataDirPath=/data
post -X POST "$BASE/setupDefaultAdministrator.do" -d setupDefaultAdministrator=true \
  --data-urlencode user.firstname=Test --data-urlencode user.lastname=Admin \
  --data-urlencode "user.email=$EMAIL" --data-urlencode "user.password=$PASSWORD" --data-urlencode "password2=$PASSWORD"
post -X POST "$BASE/setupMode.do" -d modeSelected=Test
post -X POST "$BASE/setupPublicUrl.do" -d setupPublicUrl=true -d setupProxyUrl=true --data-urlencode "baseURL=$BASE"
post -X POST "$BASE/setupInstallationComplete.do"
# The wizard downloads extensions/vocabularies from rs.gbif.org and can fail on a network hiccup while still
# answering 200: make sure the IPT really is configured (login page reachable) before declaring success.
for _ in 1 2 3 4 5 6; do
  if curl -fsS -m 30 "$BASE/login.do" | grep -q 'name="csrfToken"'; then ok=1; break; fi
  sleep 10
done
rm -f "$JAR"
[ "${ok:-0}" = 1 ] || { echo "IPT setup did not complete (login page has no CSRF token)" >&2; exit 1; }
echo "IPT configured (TEST mode) at $BASE, admin $EMAIL"
