## Tabby Command Editor — 快捷键绑定

### 一、编辑器内快捷键（焦点在编辑区，搜索框未打开，建议框未弹出）

| 快捷键 | 功能 | 备注 |
|---|---|---|
| `Tab` | **历史命令补全 / 缩进** | 有行内提示时接受当前候选；无提示时正常缩进 |
| `Shift + Tab` | **切换候选 / 取消缩进** | 有行内提示时切换到下一条历史命令；无提示时正常取消缩进 |
| `Enter` | **Send** — 发送当前行（或选中内容）到终端 | 自动去除注释；**代码块内会跳过并提示** |
| `F7` | **跳转到下一个高亮符号** | Monaco 原生 |
| `Shift + F7` | ****跳转到上一个高亮符号**** | Monaco 原生 |
| `F8` | **Send** — 同上 | |
| `F9` | **Loop or Run** — 代码块内运行整块；无选中时发送当前行并下移；有选中时循环发送 | 见第四节 |
| `F10` | **Block Run Mode** — 切换代码块运行方式 | 终端临时文件 / 后台运行 |
| `Shift + Enter` | **Save** — 保存文档 | 与全局 `Ctrl+S` 等效 |
| `Alt + Enter` | **换行** — 插入新行 | 若光标在 `<!-- -->` 注释内，自动拆分为多行块注释 |
| `Ctrl + /` | **行注释** — 切换当前行注释 | Monaco 原生 |
| `Ctrl + Shift + /` | **Markdown 块注释** — 切换 `<!-- -->` 包围 | |
| `Ctrl + \` | **折叠/展开** — 切换代码折叠 | Monaco 原生 |
| `Shift + Alt + A` | **块注释** — 切换块注释 | Monaco 原生 |
| `Ctrl + G` | **跳转到行** | Monaco 原生 |
| `Ctrl + Shift + O` | **跳转到符号** | Monaco 原生 Go to Symbol |
| `F1` | 禁用（不弹出命令面板） | |
| `Ctrl + Shift + P` | 禁用（不弹出命令面板） | |

---

### 二、Ctrl+F 搜索界面快捷键（搜索框可见时）

| 快捷键 | 功能 | 备注 |
|---|---|---|
| `Enter` | **搜索下一个** | Monaco 原生 find widget 行为 |
| `Shift + Enter` | **搜索上一个** | Monaco 原生 find widget 行为 |
| `F7` | **搜索下一个** | 同 Enter |
| `Shift + F7` | **搜索上一个** | 同 Shift + Enter |
| `Ctrl + Enter` | **Send** — 发送当前行/选中内容 | 代码块内会跳过并提示 |
| `Ctrl + Shift + Enter` | **Loop or Run** | 同 F9 |
| `F8` | **Send** | 同编辑器内 |
| `F9` | **Loop or Run** | 同编辑器内；发送后光标移到下一行（不停留在当前匹配行） |
| `F10` | **Block Run Mode** | 同编辑器内 |

---

### 三、全局快捷键（可配置，以下为 Windows/Linux 默认值）

| 快捷键 | 功能 | 对应的 Hotkey ID |
|---|---|---|
| `Ctrl + E` | 切换命令编辑器面板 | `toggle-command-editor-panel` |
| `Ctrl + F` | 打开编辑器内搜索 | `find-in-command-editor` |
| `Ctrl + O` | 打开文件 | `open-command-editor-file` |
| `Ctrl + S` | 保存文档 | `save-command-editor-file` |
| `Ctrl + Q` | 打开 Markdown 大纲 | `open-command-editor-outline` |
| `F5` | 重新加载文件 | `reload-command-editor-file` |
| `F8` | **Send** | `send-command-editor-panel` |
| `F9` | **Loop or Run**（代码块内即运行整块） | `send-command-editor-lines` |
| `F10` | **Block Run Mode** — TF / BG | `toggle-command-editor-python-log` |
| `Alt + Shift + Enter` | 跳转到符号 | `open-command-editor-symbol` |
| `Alt + Shift + G` | 打开 Python 日志文件夹 | `open-command-editor-python-log` |


> **Block run mode (F10)** 按钮显示 **TF** / **BG**：**绿色 TF** = 发送文件到终端执行，**灰色 BG** = 后台运行、日志记录到 log；悬停有完整说明，点击或按 F10 可切换。
>
> **Loop or Run (F9)** 运行代码块和循环发送共用一个热键：光标位于可运行代码块内时即直接运行；解释器由围栏语言标记决定（默认支持 `python`/`py`、`bash`/`sh`、`powershell`/`pwsh`/`ps1`）。运行命令可在 `config.yaml` → `commandEditor` 下配置，详见第七节。

---

### 四、Send 与 Loop or Run 区别

| 模式 | 行为 |
|---|---|
| **Send (Enter / F8)** | 发送当前行或选中内容；去除注释；**代码块内禁止** |
| **Loop or Run (F9)** | **代码块内运行整块**；无选中发当前行并下移；有选中则循环发送 |
| **Block Run Mode (F10)** | 切换 python/powershell/bash 代码块运行方式（见下表） |

**F10 代码块运行模式**

| 模式 | 行为 |
|---|---|
| **终端文件 (terminal)** | 将代码块写入临时文件，在**当前终端**发送命令执行 |
| **后台 (background)** | 插件后台 `spawn` 运行；**stdout** 逐行发送到终端；**stderr** 写入日志文件（任务栏预览） |

---

### 五、工具栏按钮

| 按钮 | 功能 | 等效快捷键 |
|---|---|---|
| Open | 打开文件 | `Ctrl + O` |
| Save | 保存文件 | `Ctrl + S` / `Shift + Enter` |
| Close | 关闭面板 | `Ctrl + E` |
| **Loop or Run** | 代码块内运行整块；无选中发当前行并下移；有选中则循环发送 | `F9` |
| **Send** | 发送当前行/选中内容 | `Enter` / `F8` |

---

### 六、批量发送操作

| 操作 | 说明 |
|---|---|
| 鼠标滚轮滚动间隔输入框 | 按当前单位步进：min ±1、s ±0.1、ms ±10 |
| 间隔单位下拉框 (min / s / ms) | 切换显示与滚轮步进；内部仍以秒存储 |
| 间隔 / 次数输入框 | 设置 Loop 的间隔和重复次数 |
| 点击作业状态条上的 × | 取消对应的 Loop 或后台脚本作业 |

---

### 七、代码块运行命令配置

在 Tabby 配置文件 `config.yaml` 的 `commandEditor` 节点下配置。只按 **解释器族**（`python` / `bash` / `powershell`）和 **操作系统**（Windows vs macOS/Linux）区分，**不再**根据当前终端类型（WSL / Git Bash / PowerShell 等）选择不同命令。

| 配置项 | 作用 |
|---|---|
| `codeBlockLanguageAliases` | 围栏语言标记 → 解释器族 |
| `codeBlockTerminalCommands` | **TF 模式**：发送到当前终端的命令字符串；`{file}` = 临时脚本路径 |
| `codeBlockBackgroundCommands` | **BG 模式**：后台 spawn 的命令字符串；脚本内容写入 stdin |

TF 与 BG 使用相同的命令风格（一行字符串），区别仅在于 TF 通过 `{file}` 传临时文件，BG 从 stdin 读脚本。

**默认 `codeBlockLanguageAliases`**

```yaml
codeBlockLanguageAliases:
  python: python
  py: python
  bash: bash
  sh: bash
  shell: bash
  powershell: powershell
  pwsh: powershell
  ps1: powershell
```

**Windows 默认命令**

```yaml
codeBlockTerminalCommands:
  python: python -u {file}
  bash: wsl bash {file}
  powershell: powershell -NoProfile -ExecutionPolicy Bypass -File {file}

codeBlockBackgroundCommands:
  python: py -3 -u -
  bash: bash -s
  powershell: powershell -NoProfile -NonInteractive -Command -
```

**macOS / Linux 默认命令**

```yaml
codeBlockTerminalCommands:
  python: python3 -u {file}
  bash: bash {file}
  powershell: pwsh -NoProfile -File {file}

codeBlockBackgroundCommands:
  python: python3 -u -
  bash: bash -s
  powershell: pwsh -NoProfile -NonInteractive -Command -
```

**`{file}` 路径占位符**：配置里只写 `{file}`，勿手写 `/mnt/c/...`。Windows 下若命令含 `wsl`（如 `wsl bash {file}`），插件自动将路径转为 `'/mnt/c/...'` 并加引号；否则使用 Windows 原生路径。

**自定义 WSL 发行版示例**（仅改 bash TF 命令）：

```yaml
commandEditor:
  codeBlockTerminalCommands:
    bash: wsl -d Ubuntu2 bash {file}
```

设置页 **命令编辑器 → Code block run commands** 会显示当前平台下合并后的完整 JSON。
