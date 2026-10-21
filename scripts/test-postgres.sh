#!/usr/bin/env bash
# Start a throwaway Postgres 18 for the tests gated by CRW_TEST_PG_URL, and print that URL. It is initialised with the C
# locale, as production's cluster is, and serves TLS 1.3 with a self-signed certificate for localhost. Every role signs
# in with SCRAM, apart from three that src/db/pg.test.ts expects postgresSsl=require to refuse: crw_md5 (MD5),
# crw_password (a cleartext password) and crw_trust (no password).
#
#   scripts/test-postgres.sh [container name] [port]    defaults: crw-test-pg, 55432
#   export CRW_TEST_PG_URL=…                            the line it prints
#   docker rm -f crw-test-pg                            when done
set -euo pipefail
name=${1:-crw-test-pg}
port=${2:-55432}
password=$(openssl rand -hex 16)

docker run -d --name "$name" -p "127.0.0.1:$port:5432" \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_INITDB_ARGS="--locale=C --encoding=UTF8" \
  --entrypoint bash postgres:18 -c '
    set -e
    mkdir -p /etc/crw-test && cd /etc/crw-test
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=localhost -addext subjectAltName=DNS:localhost \
      -keyout server.key -out server.crt 2>/dev/null
    printf "%s\n" "local all all trust" \
      "hostssl all crw_md5 all md5" "hostssl all crw_password all password" "hostssl all crw_trust all trust" \
      "hostssl all all all scram-sha-256" "hostnossl all all all scram-sha-256" > pg_hba.conf
    chown -R postgres:postgres /etc/crw-test && chmod 600 server.key
    printf "%s\n" "SET password_encryption = '\''md5'\'';" "CREATE ROLE crw_md5 LOGIN PASSWORD '\''crw_md5'\'';" \
      "RESET password_encryption;" "CREATE ROLE crw_password LOGIN PASSWORD '\''crw_password'\'';" \
      "CREATE ROLE crw_trust LOGIN;" > /docker-entrypoint-initdb.d/crw-roles.sql
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.3 \
      -c ssl_cert_file=/etc/crw-test/server.crt -c ssl_key_file=/etc/crw-test/server.key -c hba_file=/etc/crw-test/pg_hba.conf
  ' >/dev/null

# The entrypoint's first server, which runs the init scripts, doesn't listen on TCP; the final one does.
for _ in $(seq 60); do
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -p 5432; then
    echo "CRW_TEST_PG_URL=postgres://postgres:$password@localhost:$port/postgres"
    exit 0
  fi
  sleep 1
done
echo "Postgres in $name didn't become ready; see docker logs $name" >&2
exit 1
