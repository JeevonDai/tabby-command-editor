import { Injectable } from '@angular/core'
import { LocaleService, TranslateService } from 'tabby-core'

const ZH_CN_TRANSLATIONS: Record<string, string> = {
    'Command editor': '命令编辑器',
    'Global hotkeys': '全局快捷键',
    'These are Tabby-level hotkeys registered by the command editor. Edit their bindings in Settings -> Hotkeys.': '这些是命令编辑器注册到 Tabby 的全局快捷键，可在 设置 -> 快捷键 中修改。',
    'Action': '操作',
    'Current binding': '当前绑定',
    'Editor focus keys': '编辑器焦点按键',
    'These keys are handled only while the command editor itself is focused.': '这些按键仅在命令编辑器获得焦点时生效。',
    'Search focus keys': '搜索焦点按键',
    'These keys keep sending and running available while Monaco search is open.': '这些按键在 Monaco 搜索框打开时仍可发送或运行。',
    'Code block run commands': '代码块运行命令',
    'Customize python/bash/powershell under commandEditor in config.yaml (keys: python, bash, powershell). Platform defaults apply on Windows vs macOS/Linux. Below is the effective merged configuration.': '可在 config.yaml 的 commandEditor 下自定义 python/bash/powershell（键名为 python、bash、powershell）。Windows 与 macOS/Linux 会使用不同平台默认值。下方是合并后的有效配置。',
    'Markdown fence tag -> interpreter family (python / bash / powershell)': 'Markdown 围栏语言标记 -> 解释器类型（python / bash / powershell）',
    'BG mode: spawn command string; script body is written to stdin': 'BG 模式：后台启动命令，脚本正文写入 stdin',
    'TF mode: command sent to terminal; {file} = quoted temp script path': 'TF 模式：发送到终端的命令，{file} 表示加引号后的临时脚本路径',
}

@Injectable()
export class CommandEditorLocaleService {
    constructor (
        private translate: TranslateService,
        locale: LocaleService,
    ) {
        this.installTranslations()
        locale.localeChanged$.subscribe(() => this.installTranslations())
    }

    private installTranslations (): void {
        this.translate.setTranslation('zh-CN', ZH_CN_TRANSLATIONS, true)
        this.translate.setTranslation('zh', ZH_CN_TRANSLATIONS, true)
    }
}
