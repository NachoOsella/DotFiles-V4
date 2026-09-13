# OpenCode Context Progress

Compact terminal-native context usage bar for the OpenCode TUI sidebar.

The plugin uses a fixed 15-segment bar with `█` for used context and `░` for
remaining context. It reads the existing reactive session and model state, so
it does not poll or maintain a second usage source.
