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

overlay_notice() {
	local key="$1"
	local message="$2"

	if [[ "${DOTFILES_OVERLAY_NOTICE_KEY:-}" == "$key" ]]; then
		return 0
	fi

	DOTFILES_OVERLAY_NOTICE_KEY="$key"
	warn "$message"
}

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

overlay_host_root() {
	local host="$1"
	local out_var="${2:-}"
	local candidate="$HOSTS_DIR/$host"
	local resolved

	if [[ -d "$candidate" ]]; then
		resolved="$candidate"
		if [[ -n "$out_var" ]]; then
			printf -v "$out_var" '%s' "$resolved"
		else
			printf '%s\n' "$resolved"
		fi
		return 0
	fi

	local fallback="$HOSTS_DIR/default"
	if [[ -d "$fallback" ]]; then
		overlay_notice "$host:default" "Host overlay '$host' not found; using hosts/default"
		resolved="$fallback"
		if [[ -n "$out_var" ]]; then
			printf -v "$out_var" '%s' "$resolved"
		else
			printf '%s\n' "$resolved"
		fi
		return 0
	fi

	overlay_notice "$host:none" "Host overlay '$host' not found; continuing with base manifests only"
	return 1
}

overlay_host_packages_dir() {
	local host="$1"
	local out_var="${2:-}"
	local root

	overlay_host_root "$host" root || return 1
	if [[ -n "$out_var" ]]; then
		printf -v "$out_var" '%s/packages' "$root"
	else
		printf '%s/packages\n' "$root"
	fi
}

overlay_host_services_dir() {
	local host="$1"
	local out_var="${2:-}"
	local root

	overlay_host_root "$host" root || return 1
	if [[ -n "$out_var" ]]; then
		printf -v "$out_var" '%s/services' "$root"
	else
		printf '%s/services\n' "$root"
	fi
}

overlay_host_system_dir() {
	local host="$1"
	local out_var="${2:-}"
	local root

	overlay_host_root "$host" root || return 1
	if [[ -n "$out_var" ]]; then
		printf -v "$out_var" '%s/system' "$root"
	else
		printf '%s/system\n' "$root"
	fi
}

read_manifest() {
	local manifest="$1"
	[[ -f "$manifest" ]] || return 0
	grep -Ev '^\s*($|#)' "$manifest" || true
}

collect_manifest_packages() {
	local host="$1"
	local kind="$2"
	local overlay_packages

	read_manifest "$PACKAGES_DIR/$kind.txt"
	if overlay_host_packages_dir "$host" overlay_packages; then
		read_manifest "$overlay_packages/$kind.txt"
	fi
}

collect_service_units() {
	local host="$1"
	local scope="$2"
	local overlay_services

	if overlay_host_services_dir "$host" overlay_services; then
		read_manifest "$overlay_services/$scope.txt"
	fi
}

collect_disabled_units() {
	local host="$1"
	local overlay_services

	if overlay_host_services_dir "$host" overlay_services; then
		read_manifest "$overlay_services/system-disable.txt"
	fi
}

repo_relative() {
	local path="$1"
	if [[ "$path" == "$DOTFILES_DIR/"* ]]; then
		printf '%s\n' "${path#"$DOTFILES_DIR/"}"
	else
		printf '%s\n' "$path"
	fi
}
