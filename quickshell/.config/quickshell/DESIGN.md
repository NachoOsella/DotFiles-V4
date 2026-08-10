---
name: Quickshell
description: Compact Gruvbox Material desktop shell with contextual, nonblocking controls.
colors:
  bg-dim: "#141617"
  bg-0: "#1d2021"
  bg-1: "#282828"
  bg-3: "#3c3836"
  bg-5: "#504945"
  statusline: "#32302f"
  bar-background: "rgba(29, 32, 33, 0.96)"
  fg-0: "#d4be98"
  fg-1: "#ddc7a1"
  grey-0: "#7c6f64"
  grey-1: "#928374"
  grey-2: "#a89984"
  red: "#ea6962"
  orange: "#e78a4e"
  yellow: "#d8a657"
  green: "#a9b665"
  aqua: "#89b482"
  blue: "#7daea3"
  purple: "#d3869b"
  transparent: "transparent"
typography:
  body:
    fontFamily: "JetBrainsMono Nerd Font"
    fontSize: "17px"
    fontWeight: 600
  label:
    fontFamily: "JetBrainsMono Nerd Font"
    fontSize: "15px"
  title:
    fontFamily: "JetBrainsMono Nerd Font"
    fontSize: "17px"
    fontWeight: 700
  icon:
    fontFamily: "Symbols Nerd Font"
    fontSize: "19px"
rounded:
  none: "0px"
  sm: "2px"
  md: "4px"
spacing:
  module: "38px"
  bar: "38px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "14px"
  popup-row: "38px"
components:
  bar:
    backgroundColor: "{colors.bar-background}"
    height: "{spacing.bar}"
    rounded: "{rounded.none}"
  module-button:
    backgroundColor: "{colors.transparent}"
    textColor: "{colors.fg-0}"
    height: "{spacing.module}"
    rounded: "{rounded.none}"
  popup-surface:
    backgroundColor: "{colors.bg-1}"
    textColor: "{colors.fg-1}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  popup-row:
    backgroundColor: "{colors.transparent}"
    textColor: "{colors.fg-0}"
    height: "{spacing.popup-row}"
    rounded: "{rounded.sm}"
  accent-button:
    backgroundColor: "{colors.green}"
    textColor: "{colors.bg-0}"
    height: "{spacing.module}"
    rounded: "{rounded.sm}"
  input-field:
    backgroundColor: "{colors.bg-0}"
    textColor: "{colors.fg-1}"
    height: "38px"
    rounded: "{rounded.md}"
  slider-track:
    backgroundColor: "{colors.bg-5}"
    height: "4px"
    rounded: "{rounded.sm}"
---

# Design System: Quickshell

## Overview

**Creative North Star: "The Compact Status Instrument"**

This is a compact, flat desktop shell built in Gruvbox Material Dark Hard. The 38px top bar keeps workspace, window, media, and system state readable at a glance; larger contextual popups provide depth only when opened. The supplied captures show the bar sitting quietly over active applications rather than competing with them.

JetBrainsMono Nerd Font, one-pixel separators, tonal dark surfaces, straight corners, and semantic status colors make the system feel utilitarian and restrained. Interactions are short, local color changes and separate popup windows, not blocking overlays.

**Key Characteristics:**
- 38px flat bar with full-height modules.
- Larger 340-440px popups with 14px internal padding.
- Gruvbox Material dark neutrals with restrained semantic accents.
- Nonblocking, context-first interaction.

## Colors

The palette is warm, low-contrast Gruvbox Material dark: dark brown-grey surfaces, beige foregrounds, muted greys, and small semantic accent areas.

### Primary
- **Muted Green** (`{colors.green}`): Active workspace underline, playing media, charging state, and affirmative controls.

### Secondary
- **Muted Aqua** (`{colors.aqua}`): Network connectivity and focused network fields.

### Tertiary
- **Muted Yellow** (`{colors.yellow}`): Audio volume and brightness state.

### Neutral
- **Deep Shell** (`{colors.bg-0}`): Input backgrounds and dark bar content.
- **Popup Brown** (`{colors.bg-1}`): Popup surfaces and workspace background.
- **Raised Brown-Grey** (`{colors.bg-3}`): Borders, separators, and pressed surfaces.
- **Warm Foreground** (`{colors.fg-0}`): Normal labels and values.
- **Strong Warm Foreground** (`{colors.fg-1}`): Headings, clock, and emphasized values.
- **Muted Grey** (`{colors.grey-1}` / `{colors.grey-2}`): Secondary metadata and inactive state.

### Named Rules
**The Semantic Accent Rule.** Accents identify state or action; they do not decorate whole surfaces.

## Typography

**Display Font:** JetBrainsMono Nerd Font
**Body Font:** JetBrainsMono Nerd Font
**Label/Mono Font:** JetBrainsMono Nerd Font; icons use Symbols Nerd Font.

**Character:** Monospaced, compact, and information-forward. Normal shell text is demi-bold; popup headings are bold, while metadata drops to 11-12px and muted grey.

### Hierarchy
- **Title** (bold, 17px): Media track titles and popup headings.
- **Body** (demi-bold, 17px): Main labels and values.
- **Label** (regular, 15px): Compact module text and popup rows.
- **Icon** (20px, Symbols Nerd Font): Status and action glyphs; individual controls vary from 20-28px.

## Layout

The bar is 38px high, spans each monitor, and reserves its full height. Left modules begin at the screen edge; the right modules form a compact status row with one-pixel separators. Workspaces, active window, and launcher sit left; media is centered per monitor; network, audio, memory, battery, tray, clock, and power sit right. Notifications remain available from Control Center rather than occupying a persistent bar module.

Modules fill the 38px bar height. Popups are anchored below their triggering module with a 7px top margin and auto-adjust to screen edges. Main popup widths are 340px (power), 380px (calendar), 410px (default), 430px (control/media), and 440px (network). No responsive breakpoint system is present; the shell is instantiated per monitor.

## Elevation & Depth

The shell is flat by default and uses tonal layering instead of shadows. Depth comes from `bg-0`/`bg-1`/`bg-3` surface changes, one-pixel borders and separators, pressed/hover fills, and popup separation from the bar. No box shadows are used.

### Shadow Vocabulary
- **None:** There is no shadow vocabulary in the shipped QML.

### Named Rules
**The Flat-By-Default Rule.** Keep the bar and controls flat at rest; use tonal state changes instead of shadows or gradients.

## Shapes

The form language is square and controlled. Bar modules have no radius; compact buttons and popup rows use 2px; popup surfaces, inputs, and calendar cells use 4px. Borders are normally one pixel in the raised brown-grey neutral. The only rounded control geometry is the 4px slider track and 5px slider handle.

## Components

### Buttons
- **Shape:** Flat modules are 0px; action buttons and rows are 2px.
- **Primary:** The launcher uses muted green with dark text; state controls use semantic foreground colors on transparent modules.
- **Hover / Focus:** Hover and selected states fill with the statusline neutral; pressed states use the raised brown-grey neutral. Color changes use a 140ms OutCubic animation.
- **Secondary / Ghost / Tertiary:** Most shell actions are transparent ghost controls until hovered; destructive power actions use red.

### Cards / Containers
- **Corner Style:** Popup surfaces use 4px; notification cards use the same popup radius.
- **Background:** Popup surfaces use Popup Brown with a one-pixel raised brown-grey border.
- **Shadow Strategy:** No shadows; use tonal separation and the border.
- **Internal Padding:** Popup surfaces use 14px; internal rows are 38px high with 7-8px horizontal insets.

### Inputs / Fields
- **Style:** Password input is 38px high, Deep Shell background, one-pixel border, and 4px radius.
- **Focus:** The border changes from the neutral border to muted aqua.
- **Error / Disabled:** Errors use orange; disabled controls reduce opacity to 45% and use muted greys.

### Navigation
- **Style:** The top bar is persistent, non-focusable, and split into left, centered, and right module groups. Workspace buttons are 29px wide when visible, with a 3px inset green focused indicator or red urgent indicator.

### Sliders
- **Style:** A 4px neutral track carries a 4px semantic fill and a 10px circular handle. Audio uses yellow, brightness uses warm foreground, and media uses green.

## Do's and Don'ts

### Do:
- **Do** preserve the 38px bar and full-height module rhythm.
- **Do** keep popup surfaces larger than bar modules, padded by 14px, and anchored to the triggering module.
- **Do** use green, aqua, yellow, orange, and red only for their observed state or action meanings.
- **Do** keep interactions nonblocking: local hover/press feedback, Escape dismissal, and separate contextual popups.

### Don't:
- **Don't** introduce pill shapes, large rounded cards, gradients, or drop shadows into the shell.
- **Don't** turn the persistent bar into a dashboard or full-screen control surface.
- **Don't** use saturated accents as general backgrounds; reserve them for state and action.
