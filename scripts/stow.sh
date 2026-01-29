#!/usr/bin/env bash

# ==============================================================================
#  🛠️  PROFESSIONAL STOW MANAGER
# ==============================================================================
#  A minimal, animated, and robust dotfiles manager for Hyprland setups.
#  Author: Nacho
# ==============================================================================

# --- Safety First ---
set -euo pipefail
IFS=$'\n\t'

# --- Configuration ---
DOTFILES_DIR="${HOME}/dotfiles"
BACKUP_DIR="${HOME}/.dotfiles_backup_$(date +%Y%m%d_%H%M%S)"

# --- Gruvbox Palette & Styling ---
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
ORANGE='\033[0;91m' # Approx

# Icons
ICON_OK="✔"
ICON_FAIL="✖"
ICON_WARN="⚠"
ICON_INFO="ℹ"
ICON_PKG="📦"

# --- Packages List ---
# Agrega aquí tus carpetas a gestionar
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
	"wlogout"
	"zathura"
	"gtk"
	"qt"
	"starship"
	"opencode"
	"keepassxc"
)

# --- UI Functions ---

banner() {
	clear
	echo -e "${ORANGE}${BOLD}"
	echo "   _____ __                 __  "
	echo "  / ___// /_____ _      __ / /  "
	echo "  \__ \/ __/ __ \ | /| / // /   "
	echo " ___/ / /_/ /_/ / |/ |/ //_/    "
	echo "/____/\__/\____/|__/|__(_)      "
	echo -e "${RESET}"
	echo -e "${DIM}  Dotfiles Manager v2.0 ${RESET}"
	echo -e "${DIM}  Directory: ${DOTFILES_DIR} ${RESET}"
	echo ""
}

show_spinner() {
	local pid=$1
	local delay=0.1
	local spinstr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

	tput civis # Hide cursor

	while ps -p "$pid" >/dev/null; do
		local temp=${spinstr#?}
		printf "  ${CYAN}%c${RESET}  " "$spinstr"
		local spinstr=$temp${spinstr%"$temp"}
		sleep $delay
		printf "\b\b\b\b\b"
	done

	tput cnorm # Show cursor
	printf "     \b\b\b\b\b"
}

log_task() {
	local message="$1"
	printf "${BLUE}${ICON_PKG}${RESET}  %-30s" "$message"
}

log_success() {
	printf "${GREEN}${ICON_OK} Success${RESET}\n"
}

log_fail() {
	printf "${RED}${ICON_FAIL} Failed${RESET}\n"
}

log_skip() {
	printf "${YELLOW}${ICON_WARN} Skipped${RESET}\n"
}

# --- Core Logic ---

# Executes a command with a spinner and error handling
execute() {
	local cmd="$1"
	local msg="$2"
	local log_file="/tmp/stow_debug.log"

	log_task "$msg"

	# Run command in background and capture output
	eval "$cmd" >"$log_file" 2>&1 &
	local pid=$!

	# Show spinner while process is running
	show_spinner "$pid"

	# Wait for process to finish and get exit code
	wait "$pid"
	local exit_code=$?

	if [ $exit_code -eq 0 ]; then
		log_success
	else
		log_fail
		echo -e "\n${RED}Error Output:${RESET}"
		cat "$log_file"
		echo ""
		return 1
	fi
}

check_requirements() {
	if ! command -v stow &>/dev/null; then
		echo -e "${RED}${ICON_FAIL} GNU Stow is not installed.${RESET}"
		echo "Install it with: sudo pacman -S stow"
		exit 1
	fi

	if [[ ! -d "$DOTFILES_DIR" ]]; then
		echo -e "${RED}${ICON_FAIL} Dotfiles directory not found.${RESET}"
		exit 1
	fi
}

stow_pkg() {
	local pkg=$1
	local action=${2:-""} # "" = install, -D = delete, -R = restow

	# Check if package directory exists
	if [[ ! -d "${DOTFILES_DIR}/${pkg}" ]]; then
		printf "${YELLOW}${ICON_WARN}  %-30s ${DIM}Directory not found${RESET}\n" "$pkg"
		return 0
	fi

	# Handle conflicts strictly by backing up if installing
	if [[ -z "$action" ]]; then
		# This is a basic conflict check logic if needed in future
		# For now, we trust stow's output which we capture
		:
	fi

	execute "cd $DOTFILES_DIR && stow $action $pkg" "$pkg"
}

# --- Commands ---

cmd_install() {
	local targets=("${@}")
	if [[ ${#targets[@]} -eq 0 ]]; then targets=("${PACKAGES[@]}"); fi

	echo -e "${GREEN}${BOLD}Installing configurations...${RESET}\n"

	for pkg in "${targets[@]}"; do
		stow_pkg "$pkg" ""
	done
}

cmd_remove() {
	local targets=("${@}")
	if [[ ${#targets[@]} -eq 0 ]]; then
		echo -e "${RED}Please specify packages to remove or use 'remove-all'${RESET}"
		exit 1
	fi

	echo -e "${RED}${BOLD}Removing configurations...${RESET}\n"

	for pkg in "${targets[@]}"; do
		stow_pkg "$pkg" "-D"
	done
}

cmd_restow() {
	local targets=("${@}")
	if [[ ${#targets[@]} -eq 0 ]]; then targets=("${PACKAGES[@]}"); fi

	echo -e "${PURPLE}${BOLD}Refreshing configurations...${RESET}\n"

	for pkg in "${targets[@]}"; do
		stow_pkg "$pkg" "-R"
	done
}

cmd_status() {
	echo -e "${CYAN}${BOLD}Link Status Report:${RESET}\n"

	local count=0
	for pkg in "${PACKAGES[@]}"; do
		# Check first config file found to guess status
		local config_dir="${DOTFILES_DIR}/${pkg}/.config"

		if [[ -d "$config_dir" ]]; then
			# Get the first subfolder/file inside the package's .config
			local target_name=$(ls -A "$config_dir" | head -n 1)

			if [[ -z "$target_name" ]]; then continue; fi

			local target_path="${HOME}/.config/${target_name}"

			if [[ -L "$target_path" ]]; then
				printf "  ${GREEN}${ICON_OK}${RESET} %-15s ${DIM}-> Linked${RESET}\n" "$pkg"
			elif [[ -e "$target_path" ]]; then
				printf "  ${YELLOW}${ICON_WARN}${RESET} %-15s ${DIM}-> Exists (No Link)${RESET}\n" "$pkg"
			else
				printf "  ${DIM}${ICON_INFO}${RESET} %-15s ${DIM}-> Not installed${RESET}\n" "$pkg"
			fi
		else
			# Try root level mapping (like .zshrc)
			local root_file=$(ls -A "${DOTFILES_DIR}/${pkg}" | grep -vE "^\.config$" | head -n 1)
			if [[ -n "$root_file" ]]; then
				if [[ -L "${HOME}/${root_file}" ]]; then
					printf "  ${GREEN}${ICON_OK}${RESET} %-15s ${DIM}-> Linked${RESET}\n" "$pkg"
				else
					printf "  ${DIM}${ICON_INFO}${RESET} %-15s ${DIM}-> Not installed${RESET}\n" "$pkg"
				fi
			fi
		fi
	done
	echo ""
}

show_help() {
	echo -e "${BOLD}Usage:${RESET} ./stow.sh [command] [package]"
	echo ""
	echo -e "  ${GREEN}install, i${RESET}   [pkg]   Install package(s) (Default: all)"
	echo -e "  ${RED}remove, r${RESET}    [pkg]   Remove package(s)"
	echo -e "  ${PURPLE}restow, re${RESET}   [pkg]   Re-apply links (fix broken links)"
	echo -e "  ${CYAN}status, st${RESET}           Show connection status"
	echo -e "  ${YELLOW}list, ls${RESET}             List managed packages"
	echo ""
}

# --- Main Entry Point ---

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
		echo -e "${CYAN}Managed Packages:${RESET}"
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
