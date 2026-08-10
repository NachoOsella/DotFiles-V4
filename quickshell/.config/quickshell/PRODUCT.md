# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

A single developer uses the shell throughout daily work on an Arch Linux and Hyprland desktop, across laptop-only, dual-monitor, and docked configurations.

## Product Purpose

The shell evolves the existing Waybar into an interactive desktop shell while preserving its compact, calm, information-dense baseline. Success means the idle shell recedes into the desktop while contextual controls replace separate menus and utilities where native integration is more useful.

## Positioning

This is not a general-purpose desktop environment or a copied shell preset. It is a Quickshell implementation specifically derived from the user's existing Waybar, Rofi, Hyprland, and Hyprlock workflows.

## Operating Context

The shell runs under Hyprland on Arch Linux beside terminals, LazyVim, developer tools, Rofi, Hyprlock, NetworkManager, BlueZ, PipeWire, UPower, and MPRIS applications. It must support dynamic monitor profiles without assuming fixed hardware.

## Capabilities and Constraints

- Every implementation file lives under `~/.config/quickshell/`.
- Waybar, Rofi, Hyprlock, existing scripts, services, and system configuration remain read-only. Hyprland received only the explicitly authorized final startup replacement from Waybar to Quickshell.
- Rofi remains the application launcher.
- Native Quickshell APIs take priority over process polling.
- External commands are limited to launching existing tools, power/session actions, brightness fallback, and unavailable system operations.
- On user request, Quickshell now owns the notification server and the Dunst user service is masked to avoid D-Bus reactivation.
- Brightness writes may fail until the user grants an appropriate system permission.
- Power profiles are omitted while power-profiles-daemon is unavailable.

## Brand Commitments

The established visual identity is Gruvbox Material Dark Hard, JetBrainsMono Nerd Font, square-to-modest radii, compact spacing, warm neutral typography, restrained semantic accents, and a visually stronger green Arch button. The bar remains 38 logical pixels high and follows the incumbent module order.

## Evidence on Hand

The visual and behavioral baseline is the read-only configuration in `~/.config/waybar/`, `~/.config/hypr/`, `~/.config/rofi/`, and the Hyprlock configuration under `~/.config/hypr/`.

## Product Principles

1. Preserve the idle Waybar identity before adding interactive depth.
2. Reveal complexity only in context.
3. Prefer reactive native integration and low idle cost.
4. Keep controls honest about service support and failure states.
5. Maintain safe coexistence with the current desktop until manual cutover.

## Accessibility & Inclusion

Controls must expose clear hover, pressed, focus, disabled, warning, and critical states; text must elide instead of overflowing; interaction targets must remain usable despite the compact visual scale.
