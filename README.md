# pi-auto-rename

Pi extension that auto-renames sessions using AI. Provides a single `/rename` command with subcommands for manual renaming, model configuration, and state inspection.

## Install

```bash
pi install git:github.com/victor-software-house/pi-auto-rename
```

## Commands

### `/rename`

No arguments -- rename the current session from the full conversation history.

### `/rename model`

Open an interactive model picker to choose which model generates session names.

### `/rename model <provider/model>`

Set the naming model directly without the picker.

```text
/rename model anthropic/claude-haiku-4-5
/rename model openai/gpt-4o-mini
```

### `/rename show`

Print the current naming model.

### `/rename reset`

Restore the default naming model (`anthropic/claude-haiku-4-5`).

### `/rename help`

Print the usage string.

## Auto-naming

Sessions are named automatically after the first assistant response. The extension uses the first user message to generate a 2-6 word Title Case name. Use `/rename` (no args) at any point to regenerate the name from the full conversation history.

## Configuration

The selected naming model persists in `~/.pi/agent/extensions/pi-auto-rename.json` across sessions and restarts.

## Acknowledgments

Inspired by [pi-session-auto-rename](https://github.com/egornomic/pi-session-auto-rename) by Egor.

## License

MIT
