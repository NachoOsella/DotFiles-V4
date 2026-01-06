# Dotfiles Maintenance Guide

## Estructura del Repositorio

```
~/dotfiles/
├── scripts/
│   ├── install-packages.sh   # Instala paquetes necesarios
│   └── stow.sh               # Gestiona symlinks
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
└── starship/                 # Prompt
```

---

## Instalación en Nueva Máquina

### 1. Clonar el repositorio

```bash
git clone https://github.com/TU_USUARIO/dotfiles.git ~/dotfiles
cd ~/dotfiles
```

### 2. Instalar paquetes

```bash
./scripts/install-packages.sh
```

### 3. Aplicar dotfiles

```bash
./scripts/stow.sh all
```

### 4. Reiniciar sesión

```bash
# Cerrar sesión y volver a entrar para que los cambios surtan efecto
```

---

## Comandos Diarios

### Ver estado de symlinks

```bash
./scripts/stow.sh status
```

### Re-aplicar después de cambios

Si agregas archivos nuevos a un paquete:

```bash
./scripts/stow.sh restow nvim
```

### Remover temporalmente un paquete

```bash
./scripts/stow.sh remove hypr
```

### Instalar paquetes específicos

```bash
./scripts/stow.sh install hypr kitty fish
```

---

## Flujo de Trabajo para Cambios

### 1. Editar configuración

Los archivos están en `~/dotfiles/`, pero gracias a los symlinks, también puedes
editar directamente desde `~/.config/`:

```bash
# Estos dos comandos editan el mismo archivo:
nvim ~/dotfiles/hypr/.config/hypr/hyprland.conf
nvim ~/.config/hypr/hyprland.conf
```

### 2. Probar cambios

La mayoría de apps detectan cambios automáticamente. Para Hyprland:

```bash
hyprctl reload
```

### 3. Guardar en git

```bash
cd ~/dotfiles
git add -A
git commit -m "feat(hypr): agregar keybind para screenshot"
git push
```

---

## Agregar Nueva Aplicación

### Ejemplo: Agregar config de alacritty

```bash
# 1. Crear estructura
mkdir -p ~/dotfiles/alacritty/.config/alacritty

# 2. Mover config existente
mv ~/.config/alacritty/alacritty.toml ~/dotfiles/alacritty/.config/alacritty/

# 3. Aplicar stow
cd ~/dotfiles
stow alacritty

# 4. Agregar al array STOW_PACKAGES en scripts/stow.sh
# 5. Commit
git add -A
git commit -m "feat: add alacritty config"
```

---

## Sincronización entre Máquinas

### En máquina principal (donde hiciste cambios)

```bash
cd ~/dotfiles
git add -A
git commit -m "update: descripción de cambios"
git push
```

### En otra máquina

```bash
cd ~/dotfiles
git pull
./scripts/stow.sh restow PAQUETE_MODIFICADO
```

---

## Resolución de Conflictos

### Error: "existing target is not a symlink"

Stow no puede crear symlink porque ya existe un archivo/directorio:

```bash
# Opción 1: Backup y reintentar
mv ~/.config/nvim ~/.config/nvim.bak
./scripts/stow.sh install nvim

# Opción 2: Adoptar el archivo existente (lo mueve al repo)
cd ~/dotfiles
stow --adopt nvim
git diff  # Ver qué cambió
```

### Error: "conflicting symlinks"

Hay symlinks conflictivos:

```bash
# Ver qué está mal
./scripts/stow.sh status

# Remover y reinstalar
./scripts/stow.sh remove nvim
./scripts/stow.sh install nvim
```

---

## Buenas Prácticas

### Commits

Usa prefijos descriptivos:

- `feat(app):` - Nueva funcionalidad
- `fix(app):` - Corrección de bug
- `style(app):` - Cambios visuales/colores
- `refactor(app):` - Reorganización sin cambios funcionales
- `docs:` - Documentación

Ejemplos:

```
feat(hypr): add workspace animation
fix(waybar): correct battery module path
style(kitty): switch to gruvbox-material
refactor(fish): split config into modules
```

### Archivos a ignorar

El `.gitignore` ya excluye:

- `lazy-lock.json` (nvim)
- `fish_variables` (fish)
- Plugins de yazi (reinstalar con `ya pack -i`)
- Archivos sensibles (`*.pem`, `*credentials*`)

### Backup antes de cambios grandes

```bash
# Crear tag antes de cambios importantes
git tag -a "pre-rice-v2" -m "Backup antes de cambiar colorscheme"
git push --tags

# Si algo sale mal:
git checkout pre-rice-v2
```

---

## Comandos Útiles

```bash
# Ver todos los symlinks en .config
ls -la ~/.config | grep "^l"

# Ver diferencias no commiteadas
cd ~/dotfiles && git diff

# Ver qué paquetes tienen cambios
cd ~/dotfiles && git status

# Buscar en todos los configs
rg "pattern" ~/dotfiles

# Ver historial de un archivo
git log --oneline -- hypr/.config/hypr/hyprland.conf
```

---

## Notas Específicas

### Neovim (LazyVim)

- Plugins se reinstalan automáticamente
- `lazy-lock.json` está ignorado (versiones de plugins pueden variar)
- Para exportar plugins: `git add -f nvim/.config/nvim/lazy-lock.json`

### Fish

- `fish_variables` está ignorado (contiene estado local)
- Las funciones custom están en `fish/.config/fish/functions/`

### Yazi

- Plugins en `plugins/` están ignorados
- Reinstalar con: `ya pack -i`

### Hyprland

- Variables de monitor pueden necesitar ajuste por máquina
- Considera usar `source` para configs específicos de máquina:

```conf
# hyprland.conf
source = ~/.config/hypr/local.conf  # No versionado
```
