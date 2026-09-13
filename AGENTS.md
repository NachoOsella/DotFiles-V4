# AGENTS.md

Arch + Hyprland dotfiles. Each top-level directory is a GNU Stow package that links into `$HOME` (e.g. `nvim/.config/nvim` -> `~/.config/nvim`).

## Safe vs destructive commands

- Safe (user configs only, no sudo, no `/etc`): `./scripts/install-user.sh` (= `./scripts/stow.sh install [pkg...]`), `./scripts/stow.sh restow|status|list [pkg...]`, `stow -n -v <pkg>` to preview.
- Destructive (Arch only, needs sudo, touches packages/`/etc`/systemd): `./scripts/bootstrap.sh`, `install-packages.sh`, `apply-system.sh`, `enable-services.sh`. Always run with `--dry-run` first. `bootstrap.sh` without `--yes` requires typing `bootstrap`; it refuses non-interactive runs without `--yes`.
- `make` targets (`bootstrap`, `preflight`, `install-packages`, `apply-system`, `enable-services`, `capture`, `check`) are thin wrappers over `scripts/`.

## Verify before finishing

- `./scripts/check.sh` — required gate: `bash -n` over all shell scripts, `shellcheck -x` when installed, required-file checks, sorted-unique manifest checks.
- `./scripts/preflight.sh --dry-run` — safe Arch/pacman/sudo/stow/systemd precondition check.
- Opencode plugin: `opencode-discord-activity` has `check: tsc --noEmit` in `opencode/.config/opencode/plugins/discord-activity/package.json`.

## Conventions agents miss

- New Stow package? Register it in the `PACKAGES=()` array in `scripts/stow.sh` — `check.sh` fails if `systemd-user` (or any expected package) is missing there. `stow.sh install` with no args links everything in that array, not every directory.
- `stow.sh` pre-flights each package with `stow -n -v` and aborts on conflict instead of overwriting. Use `restow` (`stow -R`) to reapply after edits, `status` to diagnose unlinked configs.
- Package/service manifests must stay sorted and unique, no blank-line/comment tricks to bypass: `packages/pacman.txt`, `packages/aur.txt`, `hosts/<host>/services/{system,user}.txt`. `check.sh` enforces this.
- Host overlays layer on top of base: `hosts/<hostname>/packages|system|services`. Only `hosts/archlinux` exists. Host is detected from `/etc/hostname` (override with `DOTFILES_HOST` or `--host`); a missing overlay falls back to `hosts/default` or base-only with a warning.
- `system/` + `hosts/<host>/system/` mirror the filesystem root `/` and are copied with `sudo install -D` (exec bit preserved as 0755, else 0644; `.gitkeep` skipped). Never hand-edit `/etc` — edit the mirrored file and run `apply-system.sh --dry-run` first.
- `capture-system.sh` regenerates `packages/*.txt`, service lists, and NetworkManager/TLP snapshots from the live machine. Always review its diff before committing.
- `pi` package side effect: `stow.sh` runs `npm install --ignore-scripts` in `pi/.pi/agent` on fresh clones and symlinks its `node_modules` to `~/.pi/agent/node_modules`. Warns (does not fail) if `npm` is missing.
- Do not commit: `nvim lazy-lock.json`, `fish_variables`, `yazi plugins/`, `**/.pi/tasks/`, `pi sessions|git|auth.json|crash.log`, `*.kdbx`, `keepassxc.ini`, `*.pem/*.key/*secret*` — see `.gitignore`.
- Live stack: Quickshell is the bar; `waybar/` is reference-only. Hypr keybinds live in `hypr/.config/hypr/hypr/binds.lua`. `nvim/` is LazyVim, plugins in `lua/plugins/`.
