<div align="center">

<img src="assets/nothing.png" width="100%" alt="Hyprland desktop with Gruvbox Material bar" style="border-radius: 10px; margin-bottom: 20px;">

# Hyprland Dotfiles + Arch Bootstrap

[![Arch Linux](https://img.shields.io/badge/Arch_Linux-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white)](https://archlinux.org/)
[![Hyprland](https://img.shields.io/badge/Hyprland-00b4d8?style=for-the-badge&logo=hyprland&logoColor=white)](https://wiki.hyprland.org/)
[![Neovim](https://img.shields.io/badge/Neovim-57a143?style=for-the-badge&logo=neovim&logoColor=white)](https://neovim.io/)
[![Gruvbox](https://img.shields.io/badge/Gruvbox_Material-a89984?style=for-the-badge&logoColor=white)](https://github.com/sainnhe/gruvbox-material)

<br/>

**A reproducible Arch Linux setup built around Hyprland, Gruvbox Material Dark Hard, Waybar, Kitty, Fish, Neovim, Yazi and Rofi.**
<br/>
*Minimal rectangles, warm contrast, keyboard-first workflow and automated provisioning.*

<br/>

[Installation](#installation) · [Features](#features) · [Gallery](#gallery) · [Configuration](#configuration)

</div>

<br/>

---

## Features

A complete personal desktop environment focused on speed, consistency and reproducibility.

| Category | Component | Description |
|----------|-----------|-------------|
| Window manager | Hyprland | Dynamic Wayland compositor with keyboard-driven workspace flow |
| Theme | Gruvbox Material Dark Hard | Dark, warm palette shared across the desktop, terminal and editor |
| Bar | Waybar | Rectangular segmented bar with workspace, media, network, audio, battery, memory and clock modules |
| Terminal | Kitty | GPU-accelerated terminal tuned for the same color palette |
| Shell | Fish | Modern shell with autosuggestions and a Starship prompt |
| Prompt | Starship | Compact Gruvbox prompt with host, path, time and command context |
| Editor | Neovim | LazyVim-based IDE setup for development workflows |
| File manager | Yazi | Fast terminal file manager with multi-column navigation |
| Launcher | Rofi | Centered app launcher with matching border, selection and accent colors |
| System info | Fastfetch | Styled terminal system overview matching the desktop |
| Provisioning | Bash + Stow | Reproducible install flow for packages, system config, services and user dotfiles |
| Power | TLP | Laptop battery thresholds and power-management configuration |
| Network | NetworkManager + iwd | Wireless backend and service state managed from the repository |

---

## Gallery

<div align="center">

### Clean desktop
<img src="assets/nothing.png" width="90%" alt="Clean Hyprland desktop with dark vending-machine wallpaper and segmented Waybar" style="border-radius: 8px; margin-bottom: 20px;">

### Application launcher
<img src="assets/rofi.png" width="90%" alt="Rofi app launcher using the Gruvbox Material theme" style="border-radius: 8px; margin-bottom: 20px;">

### Development workspace
<img src="assets/nvim-yazi.png" width="90%" alt="Neovim and Yazi side by side in Kitty on Hyprland" style="border-radius: 8px; margin-bottom: 20px;">

### Terminal overview
<img src="assets/fastfetch.png" width="90%" alt="Kitty terminal running Fastfetch with system information" style="border-radius: 8px;">

</div>

---

## Installation

This repository manages:

- user dotfiles with `stow`
- explicit package manifests for `pacman` and AUR
- selected global config under `/etc`
- system and user `systemd` services
- host-specific overrides

### Beginner step-by-step

If this is your first time setting up these dotfiles, follow these exact steps.

1. Boot into your fresh Arch install and connect to the internet.
2. Install Git.

```bash
sudo pacman -Sy --noconfirm git
```

3. Clone this repository.

```bash
git clone https://github.com/NachoOsella/DotFiles-V4.git ~/dotfiles
```

4. Enter the directory.

```bash
cd ~/dotfiles
```

5. Run the full automated setup.

```bash
./scripts/bootstrap.sh
```

6. Reboot.

```bash
reboot
```

7. Log back in and verify the installation.

```bash
cd ~/dotfiles
./scripts/check.sh
```

Notes:

- The install can take a while because many packages are installed.
- The script will ask for your `sudo` password when needed.
- To preview actions first, run `./scripts/bootstrap.sh --dry-run`.

<details>
<summary><strong>Quick start</strong></summary>

```bash
# 1. Clone the repository
git clone https://github.com/NachoOsella/DotFiles-V4.git ~/dotfiles
cd ~/dotfiles

# 2. Bootstrap the machine
./scripts/bootstrap.sh

# 3. Reboot
reboot
```

</details>

<details>
<summary><strong>Manual installation</strong></summary>

If you prefer more control, install components individually.

```bash
# Clone
git clone https://github.com/NachoOsella/DotFiles-V4.git ~/dotfiles
cd ~/dotfiles

# Install packages from manifests
./scripts/install-packages.sh

# Apply versioned /etc config
./scripts/apply-system.sh

# Link user config
./scripts/stow.sh install

# Enable declared services
./scripts/enable-services.sh
```

</details>

---

## Configuration

### Directory structure

```tree
~/dotfiles/
├── packages/     # Package manifests for pacman and AUR
├── hosts/        # Host-specific overlays
├── system/       # Versioned /etc files
├── systemd-user/ # User units managed with stow
├── hypr/         # Hyprland window manager configuration
├── waybar/       # Status bar styling and modules
├── rofi/         # Application launcher theme
├── kitty/        # Terminal configuration
├── fish/         # Shell configuration
├── starship/     # Prompt configuration
├── nvim/         # Neovim LazyVim setup
├── yazi/         # Terminal file manager
├── fastfetch/    # System information layout
└── scripts/      # Automation and validation scripts
```

### Provisioning flow

```bash
# Apply everything on the current host
./scripts/bootstrap.sh

# Refresh package manifests from the current machine
./scripts/capture-system.sh

# Validate manifests and scripts
./scripts/check.sh
```

### Managed system areas

- `system/etc/NetworkManager/conf.d/`
  - Global NetworkManager behavior, including the `iwd` backend.
- `hosts/<host>/system/etc/tlp.d/`
  - Host-specific TLP battery thresholds.
- `hosts/<host>/services/*.txt`
  - Services to enable and conflicting units to disable or mask.

### Real host state captured

The current `archlinux` host profile includes:

- `NetworkManager.service` and `iwd.service` as the active networking stack
- `wpa_supplicant.service` and `systemd-networkd*` disabled or masked to avoid conflicts
- TLP charge thresholds at `40/60`

### Keybindings

| Key | Action |
|-----|--------|
| `SUPER + Enter` | Open terminal |
| `SUPER + D` | Open launcher |
| `SUPER + E` | Open file manager |
| `SUPER + Q` | Close window |
| `SUPER + 1-9` | Switch workspace |

Check `hypr/.config/hypr/hyprland.conf` for the full list.

---

## Tech stack

<div align="center">
  <img src="https://skillicons.dev/icons?i=arch,linux,vim,git,bash,docker,go,python,nodejs,java" alt="Technology icons" />
</div>

---

## Contributing

Contributions are welcome. Please feel free to submit a pull request.

1. Fork the project.
2. Create your feature branch: `git checkout -b feature/AmazingFeature`.
3. Commit your changes: `git commit -m 'Add some AmazingFeature'`.
4. Push to the branch: `git push origin feature/AmazingFeature`.
5. Open a pull request.

---

<div align="center">

[![License](https://img.shields.io/github/license/NachoOsella/DotFiles-V4?style=flat-square)](LICENSE)
<br/>
Made by <a href="https://github.com/NachoOsella">Nacho</a>

</div>
