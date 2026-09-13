# OpenCode Discord Activity

Publishes the current OpenCode project as Discord Rich Presence through the
Discord desktop application's local RPC endpoint.

## Usage

1. Start the Discord desktop application.
2. Run `/discord on` in OpenCode.
3. Run `/discord off` to clear the activity.
4. Run `/discord status` to inspect the local plugin state.

The plugin uses the official OpenCode Discord application and its OpenCode
assets by default. Set `DISCORD_CLIENT_ID` to use another Discord application.
