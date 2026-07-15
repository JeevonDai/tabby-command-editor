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
4. Press **F8** to send, or enable **Use Enter to send commands** and press **Enter**

The edited command will replace your current prompt content. Press Enter when ready to execute.

### Running code blocks

Place the cursor inside a fenced Python block and press **F9**, or click **Run**:

````markdown
```python
print("hello from Python")
```
````

Python, PowerShell and Bash blocks are written to temporary files and their configured
`{file}` command is sent to the current terminal. A fenced `tabby` block is different:
it runs as Python in the plugin background and automatically binds `tabby.send/read/expect`
to the terminal that was focused when the task started. Its `print()` output scrolls
in the task notification bar, and × stops the task:

```tabby
mark = tabby.mark()
tabby.send("version")
match = tabby.expect(r"Version:\s+(.+)", timeout=5, since=mark)
print("Detected version:", match.group(1))
tabby.send("next command")
```

The injected methods are `tabby.send(text)`, `tabby.read(timeout=0)`,
`tabby.tail(last=4096)`, `tabby.clear()`, `tabby.mark()`, and
`tabby.expect(pattern, timeout=5, since=None, flags=0)`. An expect timeout raises
`TimeoutError` and includes the last 4000 terminal characters in the error.

`print()` and stderr appear in the background task notification. Only `tabby.send()`
writes to the automatically bound terminal; receive APIs read that terminal's output.

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
