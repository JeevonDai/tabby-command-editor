# tabby-command-editor

A Tabby plugin that provides a rich command editor powered by Monaco (VS Code's editor).

**Press `Ctrl+E` to open your current command in a full-featured editor.**

## Features

- 🖱️ **Click anywhere** to position cursor
- ✂️ **Multi-cursor editing** (Ctrl+D to select next occurrence)
- 🔍 **Find and replace** (Ctrl+F)
- 🎨 **Shell syntax highlighting**
- 🐍 **Run Python code blocks** and insert stdout into the active terminal
- 📝 **Multi-line command support** (heredocs, line continuations)
- 🌐 **Works with SSH sessions** - no remote configuration needed
- ⚡ **Zero shell configuration** - no zshrc/bashrc changes required

## Installation

### From Plugin Manager (Recommended)

1. Open Tabby
2. Go to **Settings → Plugins**
3. Search for `tabby-command-editor`
4. Click **Install**
5. Restart Tabby

### Manual Installation

```bash
# Navigate to Tabby's plugins directory
# macOS: ~/Library/Application Support/tabby/plugins/
# Linux: ~/.config/tabby/plugins/
# Windows: %APPDATA%/tabby/plugins/

npm install tabby-command-editor
```

## Usage

1. Type a command in your terminal (don't press Enter)
2. Press **Ctrl+E** (or your configured hotkey)
3. Edit your command in the Monaco editor
4. Press **Ctrl+Enter** to apply, or **Esc** to cancel

The edited command will replace your current prompt content. Press Enter when ready to execute.

### Running Python code blocks

Place the cursor inside a fenced Python block and press **F9**, or click **Run**:

````markdown
```python
print("echo hello from Python")
```
````

Python runs locally in unbuffered mode with a 30-second output-inactivity timeout and
a 1 MiB output limit. Each complete non-empty output line is sent to the active
terminal immediately using the same behavior as **Send**: the line is followed by
Enter and is therefore executed by the active shell. Python 3 must be available as
`python3`, `python`, or Windows `py`.

Each run is bound to the terminal that was active when it started, so changing tabs
does not redirect its output. Multiple Python blocks can run concurrently. Active
runs appear in the colored task bar with their bound terminal name; completed runs
disappear automatically, and the close button stops an individual run.
Python `logging` output (stderr) is always appended to the matching task bar preview,
while `print()` output (stdout) continues to be sent to the bound terminal. Press
**F10** to toggle logs between real-time notifications and the persistent
per-run log files. Log filenames use the bound terminal name and run timestamp,
for example `C__WINDOWS_System32_WindowsPowerShell_v1.0_powershell.exe-2026-06-21T19-53-55-696Z.log`.
The log contents are written exactly as emitted by Python logging without an
additional timestamp, terminal name, or job prefix. Press **Shift+Alt+G** to
reveal the latest log file in its folder.
These three shortcuts are available in Tabby's hotkey settings as **Run Python
block in command editor**, **Toggle Python log mode in command editor**, and
**Open Python log location**.

## Configuration

The default hotkey is `Ctrl+E`. You can change this in **Settings → Hotkeys → Open command editor**.

## Compatibility

- ✅ Bash, Zsh, Fish, PowerShell
- ✅ SSH sessions (works without remote configuration)
- ✅ Custom prompts (Starship, Powerlevel10k, Oh-My-Zsh)
- ✅ Multi-line commands

## Troubleshooting

### Debugging

If command extraction isn't working correctly, open Tabby's DevTools (Ctrl+Shift+I) and check the Console for `[CommandExtraction]` logs. This shows:

- Current cursor position
- Detected command boundaries (via Ctrl+A/E probing)
- Extracted command text

### How it works

This plugin uses shell readline shortcuts (Ctrl+A and Ctrl+E) to detect command boundaries. This means it works with any prompt style without configuration - it simply asks the shell where the command starts and ends.

## Development

```bash
git clone https://github.com/Czyhandsome/tabby-command-editor.git
cd tabby-command-editor
yarn install
yarn build
```

## License

MIT
