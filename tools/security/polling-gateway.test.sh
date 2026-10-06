#!/usr/bin/env bash
# Docker prints an additional newline after a template containing println.
set -Eeuo pipefail
normalize() { printf '%s\n' "$1" | awk 'NF' | sort -u; }
valid() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
old=$(printf '172.19.0.1\n\n' | sort -u)
! valid "$old"
gateway=$(normalize $'172.19.0.1\n\n')
valid "$gateway"
[[ $gateway == 172.19.0.1 ]]
gateway=$(normalize $'\n172.19.0.1\n172.19.0.1\n\n')
valid "$gateway"
gateway=$(normalize $'172.19.0.1\n172.20.0.1\n\n')
! valid "$gateway"
gateway=$(normalize $'\n\n')
! valid "$gateway"
printf 'PASS reproduces old newline failure; fixed parsing accepts one unique gateway and rejects empty/multiple gateways\n'
