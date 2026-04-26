<div align="center">

<img src="assets/nothing.png" width="100%" alt="Hyprland desktop" style="border-radius: 10px; margin-bottom: 20px;">

# Hyprland Dotfiles

[![Arch Linux](https://img.shields.io/badge/Arch_Linux-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white)](https://archlinux.org/)
[![Hyprland](https://img.shields.io/badge/Hyprland-00b4d8?style=for-the-badge&logo=hyprland&logoColor=white)](https://wiki.hyprland.org/)
[![Neovim](https://img.shields.io/badge/Neovim-57a143?style=for-the-badge&logo=neovim&logoColor=white)](https://neovim.io/)
[![Gruvbox](https://img.shields.io/badge/Gruvbox_Material-a89984?style=for-the-badge&logoColor=white)](https://github.com/sainnhe/gruvbox-material)

<br/>

**A minimal Arch + Hyprland setup with warm Gruvbox colors, sharp rectangles and a keyboard-first workflow.**

<br/>

Kitty · Fish · Starship · Waybar · Rofi · Neovim · Yazi · Fastfetch

</div>

---

## Preview

<div align="center">

### Launcher
<img src="assets/rofi.png" width="90%" alt="Rofi launcher" style="border-radius: 8px; margin-bottom: 24px;">

### Development
<img src="assets/nvim-yazi.png" width="90%" alt="Neovim and Yazi" style="border-radius: 8px; margin-bottom: 24px;">

### Terminal
<img src="assets/fastfetch.png" width="90%" alt="Fastfetch in Kitty" style="border-radius: 8px;">

</div>

---

## Install

Clone the repo and run the bootstrap script:

```bash
git clone https://github.com/NachoOsella/DotFiles-V4.git ~/dotfiles
cd ~/dotfiles
./scripts/bootstrap.sh
```

Then reboot:

```bash
reboot
```

That is the intended flow. The script installs the needed packages, applies the system configuration, links the dotfiles and enables the required services.

If you only want to see what it would do:

```bash
./scripts/bootstrap.sh --dry-run
```

---

## What it sets up

- Hyprland desktop with a dark vending-machine wallpaper.
- Gruvbox Material Dark Hard theme across the terminal, launcher, editor and bar.
- Waybar with workspaces, media, network, audio, battery, memory and clock modules.
- Kitty + Fish + Starship for the terminal workflow.
- Neovim and Yazi side by side for coding and file navigation.
- Rofi launcher styled to match the rest of the desktop.
- Fastfetch for a clean system overview.

---

<div align="center">

[![License](https://img.shields.io/github/license/NachoOsella/DotFiles-V4?style=flat-square)](LICENSE)

Made by <a href="https://github.com/NachoOsella">Nacho</a>

</div>
