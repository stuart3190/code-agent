#!/usr/bin/env bash
set -euo pipefail

readonly RULE_COMMENT="thrallo-disposable-supabase-isolation"
readonly PORT_RANGE="55320:55327"
readonly INSTALLED_SCRIPT="/usr/local/sbin/thrallo-disposable-supabase-isolation"
readonly INSTALLED_UNIT="/etc/systemd/system/thrallo-disposable-supabase-isolation.service"

usage() {
  echo "usage: $0 <ensure|remove|status|install-service|uninstall-service>" >&2
  exit 2
}

require_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "root is required" >&2
    exit 1
  fi
}

rule_args() {
  printf '%s\n' -p tcp -m conntrack --ctorigdstport "$PORT_RANGE" ! -i lo \
    -m comment --comment "$RULE_COMMENT" -j DROP
}

chain_exists() {
  "$1" -nL DOCKER-USER >/dev/null 2>&1
}

has_rule() {
  local command=$1
  mapfile -t args < <(rule_args)
  "$command" -C DOCKER-USER "${args[@]}" >/dev/null 2>&1
}

ensure_rule() {
  local command=$1
  if ! chain_exists "$command"; then
    echo "$command DOCKER-USER chain is unavailable; Docker must be running" >&2
    exit 1
  fi
  if ! has_rule "$command"; then
    mapfile -t args < <(rule_args)
    "$command" -I DOCKER-USER 1 "${args[@]}"
  fi
  has_rule "$command"
}

remove_rule() {
  local command=$1
  chain_exists "$command" || return 0
  mapfile -t args < <(rule_args)
  while "$command" -C DOCKER-USER "${args[@]}" >/dev/null 2>&1; do
    "$command" -D DOCKER-USER "${args[@]}"
  done
}

case ${1:-} in
  ensure)
    require_root
    ensure_rule iptables
    ensure_rule ip6tables
    ;;
  remove)
    require_root
    remove_rule iptables
    remove_rule ip6tables
    ;;
  status)
    require_root
    has_rule iptables
    has_rule ip6tables
    echo "external TCP ${PORT_RANGE} is blocked in IPv4 and IPv6 DOCKER-USER; local access is unchanged"
    ;;
  install-service)
    require_root
    install -m 0755 "$(realpath "$0")" "$INSTALLED_SCRIPT"
    install -m 0644 "$(dirname "$(realpath "$0")")/systemd/thrallo-disposable-supabase-isolation.service" "$INSTALLED_UNIT"
    systemctl daemon-reload
    systemctl enable --now thrallo-disposable-supabase-isolation.service
    ;;
  uninstall-service)
    require_root
    systemctl disable --now thrallo-disposable-supabase-isolation.service 2>/dev/null || true
    remove_rule iptables
    remove_rule ip6tables
    rm -f "$INSTALLED_UNIT" "$INSTALLED_SCRIPT"
    systemctl daemon-reload
    ;;
  *) usage ;;
esac
