#!/usr/bin/env bash
# Source-only helpers. TLS verification stays enabled on every HTTPS attempt.
certificate_matches_host() {
  local file=$1 host=$2 result
  # OpenSSL 3's x509 -checkhost returns zero even for a hostname mismatch.
  result=$(LC_ALL=C openssl x509 -in "$file" -noout -checkhost "$host") || return 1
  [[ $result == "Hostname $host does match certificate" ]]
}

wait_for_http_status() {
  local url=$1 expected=$2 attempts=${3:-20}
  local attempt result='No probe made'
  for ((attempt=0; attempt<attempts; attempt++)); do
    if result=$(curl -sS --connect-timeout 2 --max-time 3 -o /dev/null -w '%{http_code}' "$url" 2>&1) && [[ $result == "$expected" ]]; then
      return 0
    fi
    if ((attempt + 1 < attempts)); then sleep 1; fi
  done
  printf 'Readiness failed: %s (expected HTTP %s). Last probe: %s\n' "$url" "$expected" "$result" >&2
  return 1
}
