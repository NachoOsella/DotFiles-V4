#!/usr/bin/env bash

# Manages user-level dotfile links with GNU Stow.
# The installer checks for conflicts before linking so existing user files are
# not overwritten or adopted implicitly.
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="${DOTFILES_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'

ICON_OK="OK"
ICON_FAIL="FAIL"
ICON_WARN="WARN"
ICON_INFO="INFO"
ICON_PKG="PKG"

PACKAGES=(
	"hypr"
	"kitty"
	"fish"
	"nvim"
	"waybar"
	"rofi"
	"dunst"
	"lazygit"
	"yazi"
	"btop"
	"fastfetch"
	"lsd"
	"zathura"
	"gtk"
	"qt"
	"starship"
	"keepassxc"
	"systemd-user"
	"pi"
	"pcmanfm-qt"
)

banner() {
	if [[ -t 1 && -n ${TERM:-} ]]; then
		clear || true
	fi
	echo -e "${BOLD}Stow dotfiles manager${RESET}"
	echo -e "${DIM}Directory: ${DOTFILES_DIR}${RESET}"
	echo ""
}

show_spinner() {
	local pid=$1
	local delay=0.1
	local spinstr='|/-\\'

	tput civis 2>/dev/null || true
	while ps -p "$pid" >/dev/null 2>&1; do
		local temp=${spinstr#?}
		printf "  ${CYAN}%c${RESET}  " "$spinstr"
		spinstr=$temp${spinstr%"$temp"}
		sleep "$delay"
		printf "\b\b\b\b\b"
	done
	tput cnorm 2>/dev/null || true
	printf "     \b\b\b\b\b"
}

log_task() {
	local message="$1"
	printf "${BLUE}${ICON_PKG}${RESET}  %-30s" "$message"
}

log_success() {
	printf "${GREEN}${ICON_OK}${RESET}\n"
}

log_fail() {
	printf "${RED}${ICON_FAIL}${RESET}\n"
}

check_requirements() {
	if ! command -v stow >/dev/null 2>&1; then
		echo -e "${RED}${ICON_FAIL} GNU Stow is not installed.${RESET}"
		echo "Install it with: sudo pacman -S stow"
		exit 1
	fi

	if [[ ! -d "$DOTFILES_DIR" ]]; then
		echo -e "${RED}${ICON_FAIL} Dotfiles directory not found.${RESET}"
		exit 1
	fi
}

execute() {
	local msg="$1"
	shift
	local log_file
	log_file="$(mktemp -t stow-debug.XXXXXX.log)"

	log_task "$msg"
	# Run the command as an argument array to preserve quoting and avoid eval.
	"$@" >"$log_file" 2>&1 &
	local pid=$!

	show_spinner "$pid"
	set +e
	wait "$pid"
	local exit_code=$?
	set -e

	if [[ $exit_code -eq 0 ]]; then
		log_success
		rm -f "$log_file"
	else
		log_fail
		echo -e "\n${RED}Error output:${RESET}"
		cat "$log_file"
		echo ""
		rm -f "$log_file"
		return 1
	fi
}

check_stow_conflicts() {
	local pkg="$1"
	local log_file
	log_file="$(mktemp -t "stow-conflicts-${pkg}.XXXXXX.log")"

	if (cd "$DOTFILES_DIR" && stow -n -v "$pkg") >"$log_file" 2>&1; then
		rm -f "$log_file"
		return 0
	fi

	echo -e "${RED}${ICON_FAIL} Conflicts detected for package '${pkg}'.${RESET}"
	echo -e "${YELLOW}GNU Stow refused to link this package because target files already exist.${RESET}"
	echo "Review the output below, back up or move your existing files, then retry."
	echo ""
	cat "$log_file"
	echo ""
	rm -f "$log_file"
	return 1
}

stow_pkg() {
	local pkg=$1
	local action=${2:-}

	if [[ ! -d "${DOTFILES_DIR}/${pkg}" ]]; then
		printf "${YELLOW}${ICON_WARN}${RESET}  %-30s ${DIM}Directory not found${RESET}\n" "$pkg"
		return 0
	fi

	if [[ -z "$action" ]]; then
		check_stow_conflicts "$pkg"
		execute "$pkg" stow -d "$DOTFILES_DIR" -t "$HOME" "$pkg"
	else
		execute "$pkg" stow -d "$DOTFILES_DIR" -t "$HOME" "$action" "$pkg"
	fi
}

cmd_install() {
	local targets=("$@")
	if [[ ${#targets[@]} -eq 0 ]]; then
		targets=("${PACKAGES[@]}")
	fi

	echo -e "${GREEN}${BOLD}Installing user configurations...${RESET}\n"

	for pkg in "${targets[@]}"; do
		stow_pkg "$pkg" ""
	done
}

cmd_remove() {
	local targets=("$@")
	if [[ ${#targets[@]} -eq 0 ]]; then
		echo -e "${RED}Please specify packages to remove or use 'remove-all'.${RESET}"
		exit 1
	fi

	echo -e "${RED}${BOLD}Removing user configurations...${RESET}\n"

	for pkg in "${targets[@]}"; do
		stow_pkg "$pkg" "-D"
	done
}

cmd_restow() {
	local targets=("$@")
	if [[ ${#targets[@]} -eq 0 ]]; then
		targets=("${PACKAGES[@]}")
	fi

	echo -e "${PURPLE}${BOLD}Refreshing user configurations...${RESET}\n"

	for pkg in "${targets[@]}"; do
		stow_pkg "$pkg" "-R"
	done
}

cmd_status() {
	echo -e "${CYAN}${BOLD}Link status report:${RESET}\n"

	for pkg in "${PACKAGES[@]}"; do
		local config_dir="${DOTFILES_DIR}/${pkg}/.config"

		if [[ -d "$config_dir" ]]; then
			local target_name
			target_name=$(find "$config_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | head -n 1)
			[[ -n "$target_name" ]] || continue

			local target_path="${HOME}/.config/${target_name}"
			if [[ -L "$target_path" ]]; then
				printf "  ${GREEN}${ICON_OK}${RESET} %-15s ${DIM}-> Linked${RESET}\n" "$pkg"
			elif [[ -e "$target_path" ]]; then
				printf "  ${YELLOW}${ICON_WARN}${RESET} %-15s ${DIM}-> Exists without link${RESET}\n" "$pkg"
			else
				printf "  ${DIM}${ICON_INFO}${RESET} %-15s ${DIM}-> Not installed${RESET}\n" "$pkg"
			fi
		fi
	done
	echo ""
}

show_help() {
	echo -e "${BOLD}Usage:${RESET} ./scripts/stow.sh [command] [package...]"
	echo ""
	echo -e "  ${GREEN}install, i${RESET}   [pkg...]   Install package links. Defaults to all packages."
	echo -e "  ${RED}remove, r${RESET}    [pkg...]   Remove package links."
	echo -e "  ${PURPLE}restow, re${RESET}   [pkg...]   Re-apply package links. Defaults to all packages."
	echo -e "  ${CYAN}status, st${RESET}              Show link status."
	echo -e "  ${YELLOW}list, ls${RESET}                List managed packages."
	echo ""
}

main() {
	check_requirements

	if [[ $# -eq 0 ]]; then
		banner
		show_help
		exit 0
	fi

	local cmd="$1"
	shift

	case "$cmd" in
	install | i | all)
		banner
		cmd_install "$@"
		;;
	remove | r)
		banner
		cmd_remove "$@"
		;;
	remove-all)
		banner
		cmd_remove "${PACKAGES[@]}"
		;;
	restow | re)
		banner
		cmd_restow "$@"
		;;
	status | st)
		banner
		cmd_status
		;;
	list | ls)
		banner
		echo -e "${CYAN}Managed packages:${RESET}"
		printf "  %s\n" "${PACKAGES[@]}"
		echo ""
		;;
	help | --help | -h)
		banner
		show_help
		;;
	*)
		echo -e "${RED}Unknown command: $cmd${RESET}"
		show_help
		exit 1
		;;
	esac
}

main "$@"
