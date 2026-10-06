#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
# shellcheck source=deploy/wait-ready.sh
source "$ROOT/deploy/wait-ready.sh"

state=$(mktemp -d)
trap 'rm -- "$state/calls"; rmdir -- "$state"' EXIT
printf '0\n' > "$state/calls"
MODE=tls-transition
curl() {
  local count args=" $* "
  [[ $args != *' -k '* && $args != *' --insecure '* ]] || return 99
  count=$(<"$state/calls")
  printf '%s\n' "$((count+1))" > "$state/calls"
  case "$MODE:$count" in
    tls-transition:0) printf 'SSL: hostname mismatch\n000'; return 60 ;;
    tls-transition:1) printf 'Connection reset\n000'; return 56 ;;
    tls-transition:*) printf '200' ;;
    denied:*) printf '403' ;;
    wrong:*) printf '503' ;;
  esac
}
sleep() { :; }
wait_for_http_status https://kanban.trisoft.ru/api/health 200 3
[[ $(<"$state/calls") == 3 ]]
printf 'PASS: transient TLS mismatch/reset retries without disabling verification\n'
MODE=denied
wait_for_http_status https://kanban.trisoft.ru/api/integrations/v1/boards 403 2
printf 'PASS: integration requires exactly HTTP 403\n'
MODE=wrong
before=$(<"$state/calls")
if wait_for_http_status https://kanban.trisoft.ru/api/health 200 2 >/dev/null 2>&1; then exit 1; fi
[[ $(<"$state/calls") == $((before+2)) ]]
printf 'PASS: persistent failure stops after the bounded retry count\n'

MATCH=false
openssl() {
  if [[ $MATCH == true ]]; then
    printf 'Hostname kanban.trisoft.ru does match certificate\n'
  else
    printf 'Hostname kanban.trisoft.ru does NOT match certificate\n'
  fi
  return 0
}
if certificate_matches_host /fake/certificate.pem kanban.trisoft.ru; then exit 1; fi
MATCH=true
certificate_matches_host /fake/certificate.pem kanban.trisoft.ru
printf 'PASS: certificate hostname guard rejects mismatch despite OpenSSL exit zero\n'
