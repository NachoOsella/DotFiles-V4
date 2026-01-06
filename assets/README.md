# Screenshots

Add your screenshots here to include them in the main README.md.

## Recommended Screenshots

### Essential (5-7 images)
1. **hyprland-workspace.png** - Full desktop showing workspaces
2. **neovim-coding.png** - Neovim with a project open
3. **terminal-fish.png** - Fish shell with starship prompt
4. **yazi-filemanager.png** - Yazi file manager
5. **hyprland-rofi.png** - Rofi launcher menu
6. **hyprland-waybar.png** - Close-up of waybar widgets
7. **neovim-lsp.png** - Neovim showing LSP features

### Optional
- **hyprland-window-rules.png** - Showing window gaps and borders
- **btop-monitor.png** - btop system monitor
- **waybar-media.png** - Waybar media player widget
- **rofi-powermenu.png** - Rofi power menu

## How to Take Screenshots

### Using Hyprshot (already installed)
```bash
# Save area screenshot to clipboard
hyprshot -m region --clipboard-only

# Save to file (creates timestamped file)
hyprshot -m region -m active_window -o ~/Pictures
```

### Using Grim (already installed)
```bash
# Capture entire output
grim ~/Pictures/screenshot.png

# Capture region (select with slurp)
grim -g "$(slurp)" ~/Pictures/screenshot.png
```

### Recommended Dimensions
- **Desktop screenshots**: 1920x1080 or 2560x1440
- **Window screenshots**: Fit to content but maintain aspect ratio
- **Avoid**: Resizing screenshots (loss of quality)

## Adding to README

After adding images to this folder, uncomment them in the main README.md:

```markdown
<!-- 
![Screenshot 1](assets/screenshot-1.png)
-->
```

Replace with:

```markdown
![Screenshot 1](assets/screenshot-1.png)
```

## Organizing

Keep filenames descriptive:
- `app-action-description.png`
- Example: `hyprland-workspace-3monitors.png`
