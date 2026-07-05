import { Injectable } from '@angular/core'
import { AppService, LocaleService, TranslateService } from 'tabby-core'

/** Minimum keys Tabby zh-CN.po should contain before we merge plugin strings. */
const TABBY_PO_MIN_KEYS = 50

export const ZH_CN_TRANSLATIONS: Record<string, string> = {
    'Command editor': '命令编辑器',
    'Global hotkeys': '全局快捷键',
    'These are Tabby-level hotkeys registered by the command editor. Edit their bindings in Settings -> Hotkeys.': '这些是命令编辑器注册到 Tabby 的全局快捷键，可在 设置 -> 快捷键 中修改。',
    'Action': '操作',
    'Current binding': '当前绑定',
    'Hotkey ID': '快捷键 ID',
    'Unassigned': '未分配',
    'Editor focus keys': '编辑器焦点按键',
    'These keys are handled only while the command editor itself is focused.': '这些按键仅在命令编辑器获得焦点时生效。',
    'Search focus keys': '搜索焦点按键',
    'These keys keep sending and running available while Monaco search is open.': '这些按键在 Monaco 搜索框打开时仍可发送或运行。',
    'Code block run commands': '代码块运行命令',
    'Configure runnable Markdown fence aliases and foreground/background commands. Save writes these values under commandEditor in config.yaml.': '配置可运行的 Markdown 围栏语言别名以及前台/后台命令。保存后会写入 config.yaml 的 commandEditor 下。',
    'Language aliases': '语言别名',
    'Markdown fence tag → interpreter': 'Markdown 围栏语言标记 → 解释器',
    'Run commands': '运行命令',
    'Configure foreground and background commands for each interpreter.': '为每种解释器配置前台和后台运行命令。',
    'Fence alias': '围栏别名',
    'Language': '语言',
    'Foreground command': '前台命令',
    'Background command': '后台命令',
    'BG mode: spawn command string; script body is written to stdin': 'BG 模式：后台启动命令，脚本正文写入 stdin',
    'TF mode: command sent to terminal; {file} = quoted temp script path': 'TF 模式：发送到终端的命令，{file} 表示加引号后的临时脚本路径',
    'Add': '添加',
    'Add interpreter': '添加解释器',
    'Remove': '删除',
    'Fill missing default aliases': '填充缺失的默认别名',
    'Fill default commands': '填充默认命令',
    'Save and apply': '保存并应用',
    'Saving...': '正在保存...',
    'Language aliases cannot be empty.': '语言别名不能为空。',
    'Language alias "{alias}" is duplicated.': '语言别名“{alias}”重复。',
    'Both commands are required for {language}.': '{language} 的前台和后台命令都不能为空。',
    'Interpreter name cannot be empty.': '解释器名称不能为空。',
    'Interpreter "{language}" is duplicated.': '解释器“{language}”重复。',
    'Code block run configuration saved and applied.': '代码块运行配置已保存并应用。',
    'Failed to save code block run configuration.': '保存代码块运行配置失败。',

    'Toggle command editor panel': '切换命令编辑器面板',
    'Open command editor panel': '打开命令编辑器面板',
    'Close command editor panel': '关闭命令编辑器面板',
    'Find in command editor': '在命令编辑器中查找',
    'Open file in command editor': '在命令编辑器中打开文件',
    'Save file in command editor': '在命令编辑器中保存文件',
    'Reload file in command editor': '在命令编辑器中重新加载文件',
    'Send or loop in command editor': '在命令编辑器中发送或循环',
    'Open markdown outline in command editor': '在命令编辑器中打开 Markdown 大纲',
    'Go to symbol in command editor': '在命令编辑器中跳转到符号',
    'Block run mode in command editor': '命令编辑器代码块运行模式',
    'Open Python log location': '打开 Python 日志位置',
    'Python API': 'Python API',
    'Select a target in the editor toolbar or press F10 to bind the current terminal. Only tabby.send() writes to the bound terminal.': '可在编辑器工具栏选择目标，或按 F10 绑定当前终端。只有 tabby.send() 会写入绑定终端。',
    'Python API target terminal': 'Python API 绑定终端',
    'Bind Python API…': '绑定 Python API…',
    'Select a Python API target terminal': '请选择 Python API 绑定终端',
    'Clear Python API binding': '清除 Python API 绑定',
    'Bind current terminal for Python API': '将当前终端绑定到 Python API',
    'Bind Python API': '绑定 Python API',
    'Bind the current terminal as the Python API send/read target': '将当前终端绑定为 Python API 的发送和回读目标',
    'Python API bound to {terminal}': 'Python API 已绑定到 {terminal}',
    'Close': '关闭',
    'Show the Python API available in terminal-run code blocks': '查看终端文件方式运行的 Python 代码块 API',
    'Python API for terminal-run code blocks': '终端运行的 Python 代码块 API',
    'Configure runnable Markdown fence aliases and terminal file commands. Save writes these values under commandEditor in config.yaml.': '配置可运行的 Markdown 围栏别名和终端文件命令，保存后写入 config.yaml。',
    'Configure the terminal file command for each interpreter.': '配置每种解释器的终端文件运行命令。',
    'A command is required for {language}.': '{language} 必须配置运行命令。',
    'Only tabby.send() writes to the bound terminal. print() and stderr stay in the terminal that runs the Python file.': '只有 tabby.send() 会写入绑定终端；print() 和 stderr 留在运行 Python 文件的终端。',
    'Send text as one or more commands to the bound terminal.': '向绑定终端发送一条或多条命令。',
    'Return the current absolute position in the terminal receive buffer.': '返回终端接收缓冲区的当前绝对位置。',
    'Wait for a regular-expression match and return a Python re.Match object.': '等待正则表达式匹配，并返回 Python re.Match 对象。',
    'Read new terminal text since the current cursor; optionally wait for data.': '读取当前游标之后的新终端文本，可选择等待数据。',
    'Return the last N characters without moving the current cursor.': '返回最后 N 个字符，不移动当前游标。',
    'Move the current cursor to the end without deleting the receive buffer.': '将当前游标移至末尾，但不删除接收缓冲区。',
    'Call mark() before send(). Terminal command echo is part of the receive stream, so use a response-specific regular expression.': '请在 send() 前调用 mark()。终端命令回显也属于接收流，因此应使用只匹配响应内容的正则表达式。',

    'Toggle panel': '切换面板',
    'Find': '查找',
    'Open file': '打开文件',
    'Save file': '保存文件',
    'Reload file': '重新加载文件',
    'Markdown outline': 'Markdown 大纲',
    'Go to symbol': '跳转到符号',
    'Send or loop': '发送或循环',
    'Stop loop': '停止循环',
    'Send': '发送',
    'Stop': '停止',
    'Block run mode': '代码块运行模式',
    'Loop or Run': '循环或运行',
    'Save': '保存',
    'New line': '换行',
    'Line comment': '行注释',
    'Smart comment': '智能注释',
    'Code block': '代码块',
    'Fold': '折叠',
    'Clipboard': '剪贴板',
    'Find next': '查找下一个',
    'Find previous': '查找上一个',
    'Go to next highlighted symbol': '跳转到下一个高亮符号',

    'Send current line or selection (blocked inside code blocks)': '发送当前行或选区（代码块内不可用）',
    'Stop active loop sends and background scripts': '停止正在进行的循环发送和后台脚本',
    'Monaco built-in (plugin does not bind F7)': 'Monaco 内置（插件未绑定 F7）',
    'Comments stripped; code block: run (terminal file or background per F10); line: send and move down (comment-only/blank: move only); selection: loop (interval × count)': '去除注释；代码块：运行（按 F10 选择终端文件或后台）；单行：发送并下移（仅注释/空行：仅移动）；选区：循环（间隔 × 次数）',
    'Toggle TF (send file to terminal) / BG (background run, stderr→log)': '切换 TF（发送文件到终端）/ BG（后台运行，stderr→日志）',
    'Save current document': '保存当前文档',
    'Insert a line without sending': '插入新行但不发送',
    'Toggle line comment': '切换行注释',
    'Markdown: <!-- -->; code blocks: select fence language': 'Markdown：<!-- -->；代码块：选择围栏语言',
    'Toggle fenced code block around the current line or selection': '在当前行或选区周围切换围栏代码块',
    'Toggle code folding': '切换代码折叠',
    'Copy, paste, cut, select all': '复制、粘贴、剪切、全选',
    'Next search match while find widget is open': '搜索框打开时跳转到下一个匹配',
    'Previous search match while find widget is open': '搜索框打开时跳转到上一个匹配',
    'Send current line while search is open (blocked inside code blocks)': '搜索打开时发送当前行（代码块内不可用）',
    'Same as editor F9; in find mode sends match line and moves to the next line': '与编辑器 F9 相同；搜索模式下发送匹配行并移到下一行',

    'No active terminal': '没有活动终端',
    'Failed to open command editor panel': '打开命令编辑器面板失败',
    'File saved': '文件已保存',
    'No file open': '没有打开的文件',
    'File not found': '找不到文件',
    'File reloaded': '文件已重新加载',
    'Nothing to send': '没有可发送的内容',
    'Terminal session not ready': '终端会话未就绪',
    'Loop send failed': '循环发送失败',
    'Lines sent': '已发送行数',
    'Send is disabled inside code blocks — use Loop or Run (F9)': '代码块内不能发送 — 请使用循环或运行（F9）',
    'Place the cursor inside a runnable code block ({languages})': '请将光标放在可运行的代码块内（{languages}）',
    'Code block is empty': '代码块为空',
    '{terminalLabel}: {languageLabel} completed without output': '{terminalLabel}：{languageLabel} 已完成，无输出',
    '{terminalLabel}: {languageLabel} output sent to terminal': '{terminalLabel}：{languageLabel} 输出已发送到终端',
    'Unsupported code block language: {language}': '不支持的代码块语言：{language}',
    '{terminalLabel}: {languageLabel} script sent to terminal ({mode})': '{terminalLabel}：{languageLabel} 脚本已发送到终端（{mode}）',
    '{terminalLabel}: {language} execution stopped': '{terminalLabel}：{language} 执行已停止',
    'TF — send code block file to the active terminal': 'TF — 将代码块文件发送到活动终端',
    'BG — run in background; stdout→terminal, stderr→log file': 'BG — 后台运行；stdout→终端，stderr→日志文件',
    'TF — send code block file to the active terminal (F10; click to switch to BG)': 'TF — 将代码块文件发送到活动终端（F10；点击切换到 BG）',
    'BG — run in background; stdout→terminal, stderr→log file (F10; click to switch to TF)': 'BG — 后台运行；stdout→终端，stderr→日志（F10；点击切换到 TF）',
    'Failed to write Python log file': '写入 Python 日志文件失败',
    'Failed to open Python log folder': '打开 Python 日志文件夹失败',

    'Editor options': '编辑器选项',
    'Right-click to send line': '右键发送当前行',
    'When enabled, right-click in the editor sends the command on that line to the terminal instead of opening the context menu.': '开启后，在编辑器内右键会将鼠标所在行的命令发送到终端，不再弹出上下文菜单。',
    'Right-click (when enabled in settings)': '右键（需在设置中开启）',
    'Send the line under the mouse cursor to the terminal; replaces the context menu': '将鼠标所在行发送到终端；替代上下文菜单',
}

function interpolate (text: string, params?: Record<string, string | number>): string {
    if (!params) {
        return text
    }
    let result = text
    for (const [name, value] of Object.entries(params)) {
        result = result.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
    return result
}

/**
 * Translate plugin-owned strings.
 * On zh-CN: uses plugin map only (never Tabby en-US.po fallback).
 * On other locales: uses the English source key with optional interpolation.
 */
export function t (
    translate: TranslateService,
    locale: LocaleService,
    key: string,
    params?: Record<string, string | number>,
): string {
    const lang = locale.getLocale()
    if (lang === 'zh-CN') {
        return interpolate(ZH_CN_TRANSLATIONS[key] ?? key, params)
    }

    const translated = translate.instant(key)
    if (translated !== key) {
        return interpolate(translated, params)
    }
    return interpolate(key, params)
}

@Injectable()
export class CommandEditorLocaleService {
    constructor (
        private translate: TranslateService,
        private locale: LocaleService,
        app: AppService,
    ) {
        this.locale.localeChanged$.subscribe(() => this.installTranslations())
        app.ready$.subscribe(() => this.installTranslations())
    }

    private installTranslations (): void {
        const lang = this.locale.getLocale()
        if (lang !== 'zh-CN') {
            return
        }

        const store = (this.translate as { translations?: Record<string, Record<string, unknown>> }).translations
        const existing = store?.[lang]
        const keyCount = existing ? Object.keys(existing).length : 0
        if (keyCount < TABBY_PO_MIN_KEYS) {
            return
        }

        this.translate.setTranslation(lang, ZH_CN_TRANSLATIONS, true)
    }
}
