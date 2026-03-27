#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

HOST="$(detect_host)"
DRY_RUN=0

usage() {
	cat <<'EOF'
Usage: ./scripts/apply-system.sh [--host HOST] [--dry-run]
Copies versioned files from system/etc and hosts/<host>/system/etc into /etc.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--host)
			shift
			[[ $# -gt 0 ]] || die "--host requires a value"
			HOST="$1"
			;;
		--dry-run)
			DRY_RUN=1
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			die "Unknown argument: $1"
			;;
	esac
	shift
done

apply_tree() {
	local source_root="$1"
	local destination_root="$2"

	[[ -d "$source_root" ]] || return 0

	while IFS= read -r -d '' entry; do
		if [[ "$(basename "$entry")" == ".gitkeep" ]]; then
			continue
		fi

		local rel="${entry#"$source_root"/}"
		local dst="$destination_root/$rel"

		if [[ -d "$entry" ]]; then
			if (( DRY_RUN )); then
				log "[dry-run] mkdir -p $dst"
			else
				sudo install -d -m 0755 "$dst"
			fi
			continue
		fi

		local mode="0644"
		if [[ -x "$entry" ]]; then
			mode="0755"
		fi

		if (( DRY_RUN )); then
			log "[dry-run] install -m $mode $entry -> $dst"
		else
			sudo install -D -m "$mode" "$entry" "$dst"
		fi
	done < <(find "$source_root" -mindepth 1 -print0 | sort -z)
}

log "Applying versioned system configuration for host '$HOST'"
apply_tree "$SYSTEM_DIR/etc" /etc
apply_tree "$(host_system_dir "$HOST")/etc" /etc
