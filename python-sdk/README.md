# tabby-terminal-sdk

Python SDK for controlling terminal tabs opened in Tabby. Tabby must be running with
the `tabby-command-editor` plugin installed.

Install the SDK from this plugin directory:

```bash
python -m pip install ./python-sdk
```

Use it from VS Code, PyCharm, a debugger, or a normal Python process:

```python
import tabby_sdk as tabby

for item in tabby.list_terminals():
    print(item.id, item.title, "active" if item.active else "")

terminal = tabby.connect()  # active terminal; an id or TerminalInfo also works
mark = terminal.mark()
terminal.send("python --version")
match = terminal.expect(r"Python\s+([\d.]+)", timeout=5, since=mark)
print("version:", match.group(1))
terminal.close()
```

The connected object supports `send`, `read`, `tail`, `clear`, `mark`, and `expect`,
matching the API injected into fenced `tabby` blocks by the plugin.

For unusual setups, set `TABBY_COMMAND_EDITOR_BRIDGE` to the path of the bridge JSON
descriptor before importing or constructing a client.
