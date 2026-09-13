# Beautiful Presenterm skill for Pi

A Pi coding-agent skill for creating polished Markdown presentations that run in the terminal with Presenterm.

## Install globally

```bash
mkdir -p ~/.pi/agent/skills
cp -R beautiful-presenterm ~/.pi/agent/skills/
```

## Install in one project

```bash
mkdir -p .pi/skills
cp -R beautiful-presenterm .pi/skills/
```

Restart Pi after installing. Pi can load it automatically when the request matches, or you can invoke it directly:

```text
/skill:beautiful-presenterm Create a 12-minute technical talk about Angular signals for intermediate frontend developers. Include speaker notes and one code walkthrough.
```

Other examples:

```text
/skill:beautiful-presenterm Turn README.md and src/ into a polished architecture presentation. Use real code and avoid live execution.
```

```text
/skill:beautiful-presenterm Review talks/current.md, fix its visual hierarchy and pacing, and preserve all factual claims.
```

## Included files

- `SKILL.md`: main workflow and quality bar.
- `assets/terminal-noir.yaml`: restrained Tokyo Night-based theme.
- `assets/presenterm.yaml`: viewport, validation, transition, and export defaults.
- `assets/starter-deck.md`: reusable slide-archetype starter.
- `references/presenterm-reference.md`: Presenterm syntax and dependency guide.
- `references/design-playbook.md`: narrative and terminal-design rules.
- `scripts/validate.sh`: static checks plus HTML render validation when Presenterm is installed.

## Presenterm installation

On Arch Linux:

```bash
sudo pacman -S presenterm
```

Other supported routes include a prebuilt release, `cargo binstall presenterm`, `cargo install --locked presenterm`, Homebrew, Nix, Scoop, and Winget.
