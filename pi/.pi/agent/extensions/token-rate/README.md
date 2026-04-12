# Token Rate Extension

Shows the average output tokens per second (TPS) in the footer status line.

<img src="../assets/token-rate-screenshot.png" alt="Token Rate Extension" width="500">

## Setup

Install the package and enable the extension:

```bash
pi install npm:token-rate-pi
pi config
```

Enable `token-rate` in `pi config`. Dependencies are installed automatically during `pi install`.

## Usage

- The status line shows `TPS: --` until it has enough data.
- After each assistant turn, it updates to `TPS: <value> tok/s`.
- Resets when the session starts or when switching sessions.

## File Structure

```
token-rate/
  token-rate.ts  # Extension entry point + status updates
  package.json   # Declares extension via "pi" field
```

## License

MIT (see repository root)
