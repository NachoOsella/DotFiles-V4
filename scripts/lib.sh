#!/usr/bin/env bash

set -euo pipefail

if [[ -n "${DOTFILES_LIB_SH_LOADED:-}" ]]; then
	return 0
fi
DOTFILES_LIB_SH_LOADED=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGES_DIR="$DOTFILES_DIR/packages"
HOSTS_DIR="$DOTFILES_DIR/hosts"
SYSTEM_DIR="$DOTFILES_DIR/system"
DEFAULT_HOST="${DOTFILES_HOST:-}"

color() {
	local code="$1"
	shift
	printf '\033[%sm%s\033[0m' "$code" "$*"
}

log() {
	printf '%s %s\n' "$(color '0;34' '[INFO]')" "$*"
}

warn() {
	printf '%s %s\n' "$(color '0;33' '[WARN]')" "$*" >&2
}

error() {
	printf '%s %s\n' "$(color '0;31' '[ERR ]')" "$*" >&2
}

die() {
	error "$*"
	exit 1
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

require_command() {
	command_exists "$1" || die "Missing required command: $1"
}

detect_host() {
	if [[ -n "$DEFAULT_HOST" ]]; then
		printf '%s\n' "$DEFAULT_HOST"
		return 0
	fi

	if [[ -r /etc/hostname ]]; then
		tr -d '\n' </etc/hostname
		return 0
	fi

	if command_exists uname; then
		uname -n
		return 0
	fi

	printf 'default\n'
}

host_root() {
	local host="$1"
	printf '%s/%s\n' "$HOSTS_DIR" "$host"
}

host_packages_dir() {
	local host="$1"
	printf '%s/packages\n' "$(host_root "$host")"
}

host_services_dir() {
	local host="$1"
	printf '%s/services\n' "$(host_root "$host")"
}

host_system_dir() {
	local host="$1"
	printf '%s/system\n' "$(host_root "$host")"
}

read_manifest() {
	local manifest="$1"
	[[ -f "$manifest" ]] || return 0
	grep -Ev '^\s*($|#)' "$manifest" || true
}

collect_manifest_packages() {
	local host="$1"
	local kind="$2"
	read_manifest "$PACKAGES_DIR/$kind.txt"
	read_manifest "$(host_packages_dir "$host")/$kind.txt"
}

collect_service_units() {
	local host="$1"
	local scope="$2"
	read_manifest "$(host_services_dir "$host")/$scope.txt"
}

collect_disabled_units() {
	local host="$1"
	read_manifest "$(host_services_dir "$host")/system-disable.txt"
}

repo_relative() {
	local path="$1"
	if [[ "$path" == "$DOTFILES_DIR/"* ]]; then
		printf '%s\n' "${path#"$DOTFILES_DIR/"}"
	else
		printf '%s\n' "$path"
	fi
}
