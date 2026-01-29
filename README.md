<div align="center">

<img src="assets/wallpaper.png" width="100%" alt="Hyprland Banner" style="border-radius: 10px; margin-bottom: 20px;">

# ⚡ Hyprland Dotfiles

[![Arch Linux](https://img.shields.io/badge/Arch_Linux-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white)](https://archlinux.org/)
[![Hyprland](https://img.shields.io/badge/Hyprland-00b4d8?style=for-the-badge&logo=hyprland&logoColor=white)](https://wiki.hyprland.org/)
[![Neovim](https://img.shields.io/badge/Neovim-57a143?style=for-the-badge&logo=neovim&logoColor=white)](https://neovim.io/)
[![Gruvbox](https://img.shields.io/badge/Gruvbox-a89984?style=for-the-badge&logoColor=white)](https://github.com/morhetz/gruvbox)

<br/>

**A meticulously crafted, minimal, and functional Hyprland setup powered by Arch Linux.**
<br/>
*Aesthetic • Performance • Workflow*

<br/>

[Installation](#-installation) · [Features](#-features) · [Gallery](#-gallery) · [Configuration](#-configuration)

<br/>

<img src="assets/setup.png" width="100%" alt="Desktop Setup" style="border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">

</div>

<br/>

---

## ✨ Features

A comprehensive environment focused on keyboard-driven productivity and visual consistency.

| Category | Component | Description |
|----------|-----------|-------------|
| **Window Manager** | Hyprland | Dynamic tiling with smooth animations and blur |
| **Theme** | Gruvbox Dark | Consistent color scheme across all applications |
| **Terminal** | Kitty | GPU-accelerated terminal with ligature support |
| **Editor** | Neovim | LazyVim distribution for a full IDE experience |
| **Shell** | Fish | Modern shell with autosuggestions and starship prompt |
| **File Manager** | Yazi | Blazing fast TUI file manager with image preview |
| **Bar** | Waybar | Highly customizable status bar with functional modules |
| **Launcher** | Rofi | Application launcher and power menu |

---

## 📸 Gallery

<div align="center">

### Workflow & Launcher
<img src="assets/rofi.png" width="90%" style="border-radius: 8px; margin-bottom: 20px;">

### Neovim Development
<img src="assets/nvim.png" width="90%" style="border-radius: 8px; margin-bottom: 20px;">

### Terminal & Files
<img src="assets/fish-yazi.png" width="90%" style="border-radius: 8px;">

</div>

---

## 📦 Installation

<details>
<summary><strong>Quick Start</strong></summary>

```bash
# 1. Clone the repository
git clone https://github.com/NachoOsella/DotFiles-V4.git ~/dotfiles
cd ~/dotfiles

# 2. Install dependencies
./scripts/install-packages.sh

# 3. Apply configurations
./scripts/stow.sh all

# 4. Reboot
reboot
```
</details>

<details>
<summary><strong>Manual Installation</strong></summary>

If you prefer more control, you can install components individually.

```bash
# Clone
git clone https://github.com/NachoOsella/DotFiles-V4.git ~/dotfiles
cd ~/dotfiles

# Install specific packages (e.g., just hyprland and kitty)
sudo pacman -S hyprland kitty

# Link specific configs
./scripts/stow.sh install hypr kitty
```
</details>

---

## ⚙️ Configuration

### Directory Structure

```tree
~/dotfiles/
├── hypr/       # Window Manager
├── nvim/       # Editor (LazyVim)
├── fish/       # Shell config
├── kitty/      # Terminal
├── waybar/     # Status bar
├── rofi/       # Launcher
└── scripts/    # Automation
```

### Keybindings

| Key | Action |
|-----|--------|
| `SUPER + Enter` | Open Terminal |
| `SUPER + D` | Open Launcher |
| `SUPER + E` | File Manager |
| `SUPER + Q` | Close Window |
| `SUPER + 1-9` | Switch Workspace |

> Check `hypr/.config/hypr/hyprland.conf` for the full list.

---

## 🛠️ Tech Stack

<div align="center">
  <img src="https://skillicons.dev/icons?i=arch,linux,vim,git,bash,docker,go,python,nodejs,java" />
</div>

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

<div align="center">

[![License](https://img.shields.io/github/license/NachoOsella/DotFiles-V4?style=flat-square)](LICENSE)
<br/>
Made with ❤️ by <a href="https://github.com/NachoOsella">Nacho</a>

</div>
