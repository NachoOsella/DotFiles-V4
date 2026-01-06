#!/bin/bash

# ============================================================
# Stow Manager - Gestiona symlinks de dotfiles
# ============================================================

set -e

DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Todos los paquetes stow disponibles
STOW_PACKAGES=(
	hypr
	kitty
	fish
	nvim
	waybar
	rofi
	dunst
	lazygit
	yazi
	btop
	fastfetch
	lsd
	wlogout
	zathura
	gtk
	qt
	starship
	opencode
	keepassxc
)

usage() {
	echo ""
	echo -e "${CYAN}Stow Manager${NC} - Gestiona symlinks de dotfiles"
	echo ""
	echo "Uso: $0 [comando] [paquetes...]"
	echo ""
	echo "Comandos:"
	echo "  install, i    Instala (stow) los paquetes especificados"
	echo "  remove, r     Remueve (unstow) los paquetes especificados"
	echo "  restow, re    Re-aplica stow (útil después de cambios)"
	echo "  all           Instala todos los paquetes"
	echo "  remove-all    Remueve todos los paquetes"
	echo "  list, ls      Lista los paquetes disponibles"
	echo "  status, st    Muestra el estado de los symlinks"
	echo "  help, -h      Muestra esta ayuda"
	echo ""
	echo "Ejemplos:"
	echo "  $0 all                    # Instala todo"
	echo "  $0 install hypr kitty     # Instala hypr y kitty"
	echo "  $0 remove nvim            # Remueve nvim"
	echo "  $0 restow hypr            # Re-aplica hypr"
	echo ""
	echo "Paquetes disponibles:"
	echo "  ${STOW_PACKAGES[*]}"
	echo ""
}

check_stow() {
	if ! command -v stow &>/dev/null; then
		log_error "stow no está instalado. Instálalo con: sudo pacman -S stow"
		exit 1
	fi
}

check_dotfiles_dir() {
	if [[ ! -d "$DOTFILES_DIR" ]]; then
		log_error "Directorio de dotfiles no encontrado: $DOTFILES_DIR"
		exit 1
	fi
}

stow_package() {
	local pkg="$1"
	local action="$2" # "" para stow, "-D" para unstow, "-R" para restow

	if [[ ! -d "$DOTFILES_DIR/$pkg" ]]; then
		log_warn "Paquete no encontrado: $pkg"
		return 1
	fi

	cd "$DOTFILES_DIR"

	case "$action" in
	"")
		if stow -v "$pkg" 2>&1; then
			log_success "Instalado: $pkg"
		else
			log_error "Error instalando: $pkg"
			return 1
		fi
		;;
	"-D")
		if stow -v -D "$pkg" 2>&1; then
			log_success "Removido: $pkg"
		else
			log_error "Error removiendo: $pkg"
			return 1
		fi
		;;
	"-R")
		if stow -v -R "$pkg" 2>&1; then
			log_success "Re-aplicado: $pkg"
		else
			log_error "Error re-aplicando: $pkg"
			return 1
		fi
		;;
	esac
}

cmd_install() {
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		log_error "Especifica al menos un paquete"
		usage
		exit 1
	fi

	log_info "Instalando paquetes..."
	for pkg in "${packages[@]}"; do
		stow_package "$pkg" ""
	done
}

cmd_remove() {
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		log_error "Especifica al menos un paquete"
		exit 1
	fi

	log_info "Removiendo paquetes..."
	for pkg in "${packages[@]}"; do
		stow_package "$pkg" "-D"
	done
}

cmd_restow() {
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		log_error "Especifica al menos un paquete"
		exit 1
	fi

	log_info "Re-aplicando paquetes..."
	for pkg in "${packages[@]}"; do
		stow_package "$pkg" "-R"
	done
}

cmd_all() {
	log_info "Instalando todos los paquetes..."
	cd "$DOTFILES_DIR"

	for pkg in "${STOW_PACKAGES[@]}"; do
		stow_package "$pkg" ""
	done

	echo ""
	log_success "Todos los paquetes instalados"
}

cmd_remove_all() {
	log_info "Removiendo todos los paquetes..."
	cd "$DOTFILES_DIR"

	for pkg in "${STOW_PACKAGES[@]}"; do
		stow_package "$pkg" "-D" 2>/dev/null || true
	done

	echo ""
	log_success "Todos los paquetes removidos"
}

cmd_list() {
	echo ""
	echo -e "${CYAN}Paquetes disponibles:${NC}"
	echo ""

	for pkg in "${STOW_PACKAGES[@]}"; do
		if [[ -d "$DOTFILES_DIR/$pkg" ]]; then
			local files=$(find "$DOTFILES_DIR/$pkg" -type f | wc -l)
			printf "  ${GREEN}%-15s${NC} (%d archivos)\n" "$pkg" "$files"
		fi
	done
	echo ""
}

cmd_status() {
	echo ""
	echo -e "${CYAN}Estado de symlinks:${NC}"
	echo ""

	for pkg in "${STOW_PACKAGES[@]}"; do
		if [[ -d "$DOTFILES_DIR/$pkg/.config" ]]; then
			# Buscar el primer directorio/archivo en .config
			local target=$(ls "$DOTFILES_DIR/$pkg/.config" | head -1)
			local link_path="$HOME/.config/$target"

			if [[ -L "$link_path" ]]; then
				printf "  ${GREEN}[LINKED]${NC}  %-15s -> %s\n" "$pkg" "$(readlink "$link_path")"
			elif [[ -e "$link_path" ]]; then
				printf "  ${YELLOW}[EXISTS]${NC}  %-15s (archivo/directorio existe, no es symlink)\n" "$pkg"
			else
				printf "  ${RED}[MISSING]${NC} %-15s\n" "$pkg"
			fi
		fi
	done
	echo ""
}

# ============================================================
# MAIN
# ============================================================

main() {
	check_stow
	check_dotfiles_dir

	local cmd="${1:-help}"
	shift 2>/dev/null || true

	case "$cmd" in
	install | i)
		cmd_install "$@"
		;;
	remove | r)
		cmd_remove "$@"
		;;
	restow | re)
		cmd_restow "$@"
		;;
	all)
		cmd_all
		;;
	remove-all)
		cmd_remove_all
		;;
	list | ls)
		cmd_list
		;;
	status | st)
		cmd_status
		;;
	help | -h | --help)
		usage
		;;
	*)
		log_error "Comando desconocido: $cmd"
		usage
		exit 1
		;;
	esac
}

main "$@"
