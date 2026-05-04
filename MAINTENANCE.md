# Dotfiles Maintenance Guide

## Estructura del Repositorio

```
~/dotfiles/
├── packages/                  # Manifiestos de paquetes
├── hosts/                     # Overlays por host
├── system/                    # Config versionada de /etc
├── scripts/
│   ├── bootstrap.sh          # Full orchestration
│   ├── install-packages.sh   # Instala paquetes desde manifests
│   ├── apply-system.sh       # Copia system/etc a /etc
│   ├── enable-services.sh    # Habilita units declaradas
│   ├── capture-system.sh     # Regenerate manifests from machine
│   ├── check.sh              # Quick validations
│   └── stow.sh               # Gestiona symlinks de usuario
├── hypr/                     # Hyprland config
├── kitty/                    # Terminal
├── fish/                     # Shell
├── nvim/                     # Neovim (LazyVim)
├── waybar/                   # Barra de estado
├── rofi/                     # Launcher
├── dunst/                    # Notificaciones
├── lazygit/                  # Git TUI
├── yazi/                     # File manager
├── btop/                     # System monitor
├── fastfetch/                # System info
├── lsd/                      # ls mejorado
├── wlogout/                  # Logout menu
├── zathura/                  # PDF viewer
├── gtk/                      # GTK 3/4 theming
├── qt/                       # Qt5/6 + Kvantum theming
├── systemd-user/             # Units de usuario via stow
└── starship/                 # Prompt
```

---

## Installation on New Machine

### 1. Clonar el repositorio

```bash
git clone https://github.com/TU_USUARIO/dotfiles.git ~/dotfiles
cd ~/dotfiles
```

### 2. Instalar paquetes

```bash
./scripts/bootstrap.sh
```

### 3. Re-aplicar por partes

```bash
./scripts/install-packages.sh   # Paquetes
./scripts/apply-system.sh       # /etc
./scripts/stow.sh install       # ~/.config y afines
./scripts/enable-services.sh    # systemd system/user
```

### 4. Restart session

```bash
# Log out and log back in so changes take effect
```

---

## Comandos Diarios

### Ver estado de symlinks

```bash
./scripts/stow.sh status
```

### Verificar manifests y scripts

```bash
./scripts/check.sh
```

### Regenerate manifests from current machine

```bash
./scripts/capture-system.sh
```

### Re-apply after changes

If you add new files to a package:

```bash
./scripts/stow.sh restow nvim
```

### Remover temporalmente un paquete

```bash
./scripts/stow.sh remove hypr
```

---

## Workflow for Changes

### 1. Edit configuration

Files are in `~/dotfiles/`, but thanks to symlinks, you can also
edit directly from `~/.config/`:

```bash
# These two commands edit the same file:
nvim ~/dotfiles/hypr/.config/hypr/hyprland.conf
nvim ~/.config/hypr/hyprland.conf
```

### 2. Test changes

Most apps detect changes automatically. For Hyprland:

```bash
hyprctl reload
```

### 3. Save in git

```bash
cd ~/dotfiles
git add -A
git commit -m "feat(hypr): add keybind for screenshot"
git push
```

---

## Add New Application

### Example: Add alacritty config

```bash
# 1. Create structure
mkdir -p ~/dotfiles/alacritty/.config/alacritty

# 2. Move existing config
mv ~/.config/alacritty/alacritty.toml ~/dotfiles/alacritty/.config/alacritty/

# 3. Apply stow
cd ~/dotfiles
stow alacritty

# 4. Add to STOW_PACKAGES array in scripts/stow.sh
# 5. Commit
git add -A
git commit -m "feat: add alacritty config"
```

---

## Sync Between Machines

### On main machine (where you made changes)

```bash
cd ~/dotfiles
git add -A
git commit -m "update: change description"
git push
```

### On another machine

```bash
cd ~/dotfiles
git pull
./scripts/bootstrap.sh
```

---

## Conflict Resolution

### Error: "existing target is not a symlink"

Stow cannot create the symlink because a file/directory already exists:

```bash
# Option 1: Backup and retry
mv ~/.config/nvim ~/.config/nvim.bak
./scripts/stow.sh install nvim

# Option 2: Adopt existing file (moves it to repo)
cd ~/dotfiles
stow --adopt nvim
git diff  # See what changed
```

### Error: "conflicting symlinks"

There are conflicting symlinks:

```bash
# See what is wrong
./scripts/stow.sh status

# Remove and reinstall
./scripts/stow.sh remove nvim
./scripts/stow.sh install nvim
```

---

## Best Practices

### Commits

Use descriptive prefixes:

- `feat(app):` - New functionality
- `fix(app):` - Bug fix
- `style(app):` - Visual/color changes
- `refactor(app):` - Reorganization with no functional changes
- `docs:` - Documentation

Ejemplos:

```
feat(hypr): add workspace animation
fix(waybar): correct battery module path
style(kitty): switch to gruvbox-material
refactor(fish): split config into modules
```

### Files to ignore

`.gitignore` already excludes:

- `lazy-lock.json` (nvim)
- `fish_variables` (fish)
- Yazi plugins (reinstall with `ya pack -i`)
- Sensitive files (`*.pem`, `*credentials*`)

### Backup before major changes

```bash
# Create tag before major changes
git tag -a "pre-rice-v2" -m "Backup before changing colorscheme"
git push --tags

# If something goes wrong:
git checkout pre-rice-v2
```

---

## Useful Commands

```bash
# See all symlinks in .config
ls -la ~/.config | grep "^l"

# See uncommitted differences
cd ~/dotfiles && git diff

# See which packages have changes
cd ~/dotfiles && git status

# Search across all configs
rg "pattern" ~/dotfiles

# See file history
git log --oneline -- hypr/.config/hypr/hyprland.conf
```

---

## Specific Notes

### Neovim (LazyVim)

- Plugins reinstall automatically
- `lazy-lock.json` is ignored (plugin versions may vary)
- To export plugins: `git add -f nvim/.config/nvim/lazy-lock.json`

### Fish

- `fish_variables` is ignored (contains local state)
- Custom functions are in `fish/.config/fish/functions/`

### Yazi

- Plugins in `plugins/` are ignored
- Reinstall with: `ya pack -i`

### Hyprland

- Monitor variables may need per-machine adjustments
- Consider using `source` for machine-specific configs:

```conf
# hyprland.conf
source = ~/.config/hypr/local.conf  # Not versioned
```

---

## Update README

### Add Screenshots

1. **Take screenshots** with hyprshot or grim:

```bash
# Region screenshot to file
hyprshot -m region -o ~/Pictures

# Or from clipboard: paste and save as .png
```

2. **Copy to repo**:

```bash
mv ~/Pictures/hyprshot_*.png ~/dotfiles/assets/hyprland-workspace.png
```

3. **Update README.md**:

Uncomment lines in the "Gallery" section:

```markdown
<!-- 
![Screenshot 1](assets/screenshot-1.png)
-->
```

Change it to:

```markdown
![Hyprland Workspace](assets/hyprland-workspace.png)
```

4. **Commit changes**:

```bash
cd ~/dotfiles
git add README.md assets/
git commit -m "docs: add screenshots to README"
git push
```

### Screenshot Recommendations

**Esenciales:**
- Full desktop (2-3 workspaces)
- Neovim with project
- Terminal with fish/starship
- Rofi launcher
- Yazi file manager

**Dimensiones:**
- Desktop: 1920x1080 o 2560x1440
- Window: fit to content, no resizing

Avoid resizing images - it reduces quality.

### Actualizar Badges

To add new badges to the README, use [shields.io](https://shields.io/):

```markdown
[![Nombre](https://img.shields.io/badge/NOMBRE-COLOR?style=for-the-badge&logo=nombre&logoColor=white)](URL)
```

Colores hex comunes:
- `1793d1` - Arch Blue
- `00b4d8` - Hyprland Cyan
- `57a143` - Neovim Green
- `f05032` - Git Red
