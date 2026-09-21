#!/usr/bin/env bash
# Disposable IPT for tests: official Tomcat image + a built ipt.war.
# Tomcat listens on the same port inside and outside the container so the IPT's
# base-URL self-check (done from inside) and the tests (from outside) agree.
set -euo pipefail
WAR="${IPT_WAR:?set IPT_WAR to the path of ipt.war}"
PORT="${IPT_PORT:-18080}"
DATA="${IPT_DATA:-$(mktemp -d)}"
NAME="${IPT_CONTAINER:-ipt-test}"
chmod 777 "$DATA"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT:$PORT" --add-host=host.docker.internal:host-gateway \
  -v "$WAR:/usr/local/tomcat/webapps/ipt.war:ro" -v "$DATA:/data" \
  -e JAVA_OPTS="-Xmx1g" tomcat:10.1-jre17 \
  sh -c "sed -i 's/port=\"8080\"/port=\"$PORT\"/' conf/server.xml && exec catalina.sh run" >/dev/null
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://localhost:$PORT/ipt/" || true)
  [ "$code" = 302 ] || [ "$code" = 200 ] && { echo "IPT up on http://localhost:$PORT/ipt (data: $DATA)"; exit 0; }
  sleep 3
done
docker logs "$NAME" | tail -30; exit 1
