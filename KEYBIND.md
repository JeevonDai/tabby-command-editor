# Tabby Command Editor — 快捷键绑定

## 一、编辑器内快捷键（焦点在编辑区，搜索框未打开，建议框未弹出）

| 快捷键 | 功能 | 备注 |
|---|---|---|
| `Enter` | **Send** — 发送当前行（或选中内容）到终端 | 自动去除注释 |
| `F8` | **Send** — 同上 | |
| `Shift + Enter` | **Save** — 保存文档 | 与全局 `Ctrl+S` 等效；首次保存会弹出另存为对话框 |
| `Alt + Enter` | **换行** — 插入新行 | 若光标在 `<!-- -->` 注释内，自动拆分为多行块注释 |
| `Ctrl + /` | **行注释** — 切换当前行注释 | Monaco 原生 `editor.action.commentLine` |
| `Ctrl + Shift + /` | **Markdown 块注释** — 切换 `<!-- -->` 包围 | |
| `Ctrl + \` | **折叠/展开** — 切换代码折叠 | Monaco 原生 `editor.toggleFold` |
| `Shift + Alt + A` | **块注释** — 切换块注释 | Monaco 原生 `editor.action.blockComment` |
| `Ctrl + G` | **跳转到行** | Monaco 原生 |
| `Ctrl + Shift + O` | **跳转到符号** | Monaco 原生 Go to Symbol |
| `F1` | 禁用（不弹出命令面板） | |
| `Ctrl + Shift + P` | 禁用（不弹出命令面板） | |

---

## 二、Ctrl+F 搜索界面快捷键（搜索框可见时）

| 快捷键 | 功能 | 备注 |
|---|---|---|
| `Enter` | **搜索下一个** | Monaco 原生 find widget 行为 |
| `Shift + Enter` | **搜索上一个** | Monaco 原生 find widget 行为 |
| `Ctrl + Enter` | **Send** — 发送当前行/选中内容到终端 | 搜索框打开时也能直接发送，无需关闭搜索框 |
| `Ctrl + Shift + Enter` | **Loop** 或 **Run** — 若光标在 \`\`\`python 代码块中则 Run，否则 Loop | 自动判断代码块位置 |

---

## 三、全局快捷键（可配置，以下为 Windows/Linux 默认值）

| 快捷键 | 功能 | 对应的 Hotkey ID |
|---|---|---|
| `Ctrl + E` | 切换命令编辑器面板（打开/关闭） | `toggle-command-editor-panel` |
| `Ctrl + F` | 打开编辑器内搜索（Find） | `find-in-command-editor` |
| `Ctrl + O` | 打开文件到编辑器 | `open-command-editor-file` |
| `Ctrl + S` | 保存编辑器文档 | `save-command-editor-file` |
| `Ctrl + Q` | 打开 Markdown 大纲 | `open-command-editor-outline` |
| `F5` | 重新加载文件 | `reload-command-editor-file` |
| `F7` | **Loop** — 循环发送选中的行 | `send-command-editor-lines` |
| `F9` | **Run** — 运行光标所在的 Python 代码块 | `run-command-editor-python` |
| `F10` | 切换 Python 日志模式（通知 / 文件） | `toggle-command-editor-python-log` |
| `Alt + Shift + Enter` | 跳转到符号 | `open-command-editor-symbol` |
| `Alt + Shift + G` | 打开 Python 日志文件夹 | `open-command-editor-python-log` |

> **macOS 默认值**：上述 `Ctrl` 替换为 `⌘`（Cmd），其余相同。

---

## 四、编辑器内 Ctrl 组合键（剪切板操作）

当编辑器或 Monaco 浮层输入框（搜索框等）聚焦时，以下快捷键在捕获阶段被拦截处理：

| 快捷键 | 功能 |
|---|---|
| `Ctrl + C` | 复制 |
| `Ctrl + V` | 粘贴 |
| `Ctrl + X` | 剪切 |
| `Ctrl + A` | 全选 |

---

## 五、工具栏按钮

| 按钮 | 功能 | 等效快捷键 |
|---|---|---|
| Open | 打开文件 | `Ctrl + O` |
| Save | 保存文件 | `Ctrl + S` / `Shift + Enter` |
| Close | 关闭面板 | `Ctrl + E` |
| **Send** | 发送当前行/选中内容 | `Enter` / `F8` |
| **Loop** | 循环发送（可配置间隔和次数） | `F7` |
| **Run** | 运行 Python 代码块 | `F9` |

---

## 六、Loop 模式操作

| 操作 | 说明 |
|---|---|
| 鼠标滚轮滚动 Loop 按钮 | 微调发送间隔（步长 10ms） |
| 点击 Loop 按钮旁的数字输入框 | 手动设置间隔（秒）和循环次数 |
| 点击作业状态条上的 × | 取消对应的 Loop 作业 |
