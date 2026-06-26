import { ChangeDetectorRef, Component, Injectable } from '@angular/core'
import { ConfigService, LocaleService, TranslateService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { formatCodeBlockRunConfigForDisplay } from './codeBlockRunConfig'
import { t } from './locale'

interface ShortcutRow {
    name: string
    keys: string
    detail: string
}

interface GlobalShortcutRow {
    id: string
    name: string
    keys: string
}

const GLOBAL_SHORTCUTS: Array<{ id: string; name: string }> = [
    { id: 'toggle-command-editor-panel', name: 'Toggle panel' },
    { id: 'find-in-command-editor', name: 'Find' },
    { id: 'open-command-editor-file', name: 'Open file' },
    { id: 'save-command-editor-file', name: 'Save file' },
    { id: 'reload-command-editor-file', name: 'Reload file' },
    { id: 'open-command-editor-outline', name: 'Markdown outline' },
    { id: 'open-command-editor-symbol', name: 'Go to symbol' },
    { id: 'send-command-editor-lines', name: 'Send or loop' },
    { id: 'cancel-command-editor-loop', name: 'Stop loop' },
    { id: 'send-command-editor-panel', name: 'Send' },
    { id: 'toggle-command-editor-python-log', name: 'Block run mode' },
    { id: 'open-command-editor-python-log', name: 'Open Python log location' },
]

const EDITOR_SHORTCUTS: ShortcutRow[] = [
    { keys: 'Enter / F8', name: 'Send', detail: 'Send current line or selection (blocked inside code blocks)' },
    { keys: 'F6', name: 'Stop', detail: 'Stop active loop sends and background scripts' },
    { keys: 'F7', name: 'Go to next highlighted symbol', detail: 'Monaco built-in (plugin does not bind F7)' },
    { keys: 'F9', name: 'Loop or Run', detail: 'Comments stripped; code block: run (terminal file or background per F10); line: send and move down (comment-only/blank: move only); selection: loop (interval × count)' },
    { keys: 'F10', name: 'Block run mode', detail: 'Toggle TF (send file to terminal) / BG (background run, stderr→log)' },
    { keys: 'Shift+Enter', name: 'Save', detail: 'Save current document' },
    { keys: 'Alt+Enter', name: 'New line', detail: 'Insert a line without sending' },
    { keys: 'Ctrl+/', name: 'Line comment', detail: 'Toggle line comment' },
    { keys: 'Ctrl+Shift+/', name: 'Smart comment', detail: 'Markdown: <!-- -->; code blocks: select fence language' },
    { keys: 'Alt+A', name: 'Code block', detail: 'Toggle fenced code block around the current line or selection' },
    { keys: 'Ctrl+\\', name: 'Fold', detail: 'Toggle code folding' },
    { keys: 'Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A', name: 'Clipboard', detail: 'Copy, paste, cut, select all' },
]

const FIND_SHORTCUTS: ShortcutRow[] = [
    { keys: 'Enter / F7', name: 'Find next', detail: 'Next search match while find widget is open' },
    { keys: 'Shift+Enter / Shift+F7', name: 'Find previous', detail: 'Previous search match while find widget is open' },
    { keys: 'F6', name: 'Stop', detail: 'Stop active loop sends and background scripts' },
    { keys: 'F8 / Ctrl+Enter', name: 'Send', detail: 'Send current line while search is open (blocked inside code blocks)' },
    { keys: 'F9 / Ctrl+Shift+Enter', name: 'Loop or Run', detail: 'Same as editor F9; in find mode sends match line and moves to the next line' },
    { keys: 'F10', name: 'Block run mode', detail: 'Toggle TF (send file to terminal) / BG (background run, stderr→log)' },
]

@Injectable()
export class CommandEditorSettingsTabProvider extends SettingsTabProvider {
    id = 'command-editor'
    icon = 'fas fa-edit'
    title: string
    weight = 10
    prioritized = false

    constructor (
        private translate: TranslateService,
        private locale: LocaleService,
    ) {
        super()
        this.refreshTitle()
        this.locale.localeChanged$.subscribe(() => this.refreshTitle())
    }

    private refreshTitle (): void {
        this.title = t(this.translate, this.locale, 'Command editor')
    }

    getComponentType (): any {
        return CommandEditorSettingsTabComponent
    }
}

@Component({
    selector: 'command-editor-settings-tab',
    template: `
        <div class="command-editor-settings">
            <section>
                <h3>{{ labels.globalHotkeys }}</h3>
                <p class="text-muted">{{ labels.globalHotkeysDesc }}</p>
                <div class="command-editor-shortcut-table">
                    <div class="command-editor-shortcut-row header">
                        <span>{{ labels.action }}</span>
                        <span>{{ labels.currentBinding }}</span>
                        <span>{{ labels.hotkeyId }}</span>
                    </div>
                    <div class="command-editor-shortcut-row" *ngFor="let shortcut of globalShortcuts">
                        <span>{{ shortcut.name }}</span>
                        <span><kbd>{{ shortcut.keys }}</kbd></span>
                        <code>{{ shortcut.id }}</code>
                    </div>
                </div>
            </section>

            <section>
                <h3>{{ labels.editorFocusKeys }}</h3>
                <p class="text-muted">{{ labels.editorFocusKeysDesc }}</p>
                <div class="command-editor-shortcut-table compact">
                    <div class="command-editor-shortcut-row" *ngFor="let shortcut of editorShortcuts">
                        <span><kbd>{{ shortcut.keys }}</kbd></span>
                        <strong>{{ shortcut.name }}</strong>
                        <span class="text-muted">{{ shortcut.detail }}</span>
                    </div>
                </div>
            </section>

            <section>
                <h3>{{ labels.searchFocusKeys }}</h3>
                <p class="text-muted">{{ labels.searchFocusKeysDesc }}</p>
                <div class="command-editor-shortcut-table compact">
                    <div class="command-editor-shortcut-row" *ngFor="let shortcut of findShortcuts">
                        <span><kbd>{{ shortcut.keys }}</kbd></span>
                        <strong>{{ shortcut.name }}</strong>
                        <span class="text-muted">{{ shortcut.detail }}</span>
                    </div>
                </div>
            </section>

            <section>
                <h3>{{ labels.codeBlockRun }}</h3>
                <p class="text-muted">{{ labels.codeBlockRunDesc }}</p>
                <ul class="command-editor-config-keys text-muted">
                    <li>codeBlockLanguageAliases — {{ labels.codeBlockAliases }}</li>
                    <li>codeBlockTerminalCommands — {{ labels.codeBlockTf }}</li>
                    <li>codeBlockBackgroundCommands — {{ labels.codeBlockBg }}</li>
                </ul>
                <pre class="command-editor-config-json">{{ codeBlockRunConfigJson }}</pre>
            </section>
        </div>
    `,
    styles: [`
        .command-editor-settings {
            display: flex;
            flex-direction: column;
            gap: 28px;
            max-width: 980px;
        }

        .command-editor-settings h3 {
            margin: 0 0 8px;
            font-size: 18px;
            font-weight: 600;
        }

        .command-editor-settings p {
            margin: 0 0 12px;
        }

        .command-editor-shortcut-table {
            display: grid;
            border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.14));
            border-radius: 4px;
            overflow: hidden;
        }

        .command-editor-shortcut-row {
            display: grid;
            grid-template-columns: minmax(160px, 1fr) minmax(140px, 220px) minmax(220px, 1.1fr);
            gap: 12px;
            align-items: center;
            padding: 9px 12px;
            border-bottom: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.12));
        }

        .command-editor-shortcut-row:last-child {
            border-bottom: 0;
        }

        .command-editor-shortcut-row.header {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            color: var(--bs-secondary-color, #888);
            background: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.04));
        }

        .command-editor-shortcut-table.compact .command-editor-shortcut-row {
            grid-template-columns: minmax(180px, 240px) minmax(120px, 180px) minmax(260px, 1fr);
        }

        .command-editor-settings kbd {
            display: inline-block;
            max-width: 100%;
            padding: 2px 6px;
            overflow: hidden;
            text-overflow: ellipsis;
            vertical-align: middle;
            color: var(--bs-body-color, #ddd);
            background: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.08));
            border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.16));
            border-bottom-width: 2px;
            border-radius: 3px;
            font-size: 12px;
            font-family: monospace;
            font-weight: 500;
        }

        .command-editor-settings code {
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--bs-secondary-color, #aaa);
        }

        .command-editor-config-keys {
            margin: 0 0 12px;
            padding-left: 1.2rem;
            font-size: 13px;
        }

        .command-editor-config-keys li {
            margin-bottom: 4px;
        }

        .command-editor-config-json {
            margin: 0;
            padding: 12px;
            max-height: 420px;
            overflow: auto;
            font-size: 12px;
            line-height: 1.45;
            font-family: monospace;
            color: var(--bs-body-color, #ddd);
            background: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.04));
            border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.14));
            border-radius: 4px;
            white-space: pre;
        }

        @media (max-width: 820px) {
            .command-editor-shortcut-row,
            .command-editor-shortcut-table.compact .command-editor-shortcut-row {
                grid-template-columns: 1fr;
                gap: 5px;
            }
        }
    `],
})
export class CommandEditorSettingsTabComponent {
    labels: Record<string, string> = {}
    editorShortcuts: ShortcutRow[] = []
    findShortcuts: ShortcutRow[] = []

    constructor (
        private config: ConfigService,
        private translate: TranslateService,
        private locale: LocaleService,
        private cdr: ChangeDetectorRef,
    ) {
        this.refreshLocalizedContent()
        this.locale.localeChanged$.subscribe(() => {
            this.refreshLocalizedContent()
            this.cdr.markForCheck()
        })
    }

    private refreshLocalizedContent (): void {
        this.labels = {
            globalHotkeys: t(this.translate, this.locale, 'Global hotkeys'),
            globalHotkeysDesc: t(this.translate, this.locale, 'These are Tabby-level hotkeys registered by the command editor. Edit their bindings in Settings -> Hotkeys.'),
            action: t(this.translate, this.locale, 'Action'),
            currentBinding: t(this.translate, this.locale, 'Current binding'),
            hotkeyId: t(this.translate, this.locale, 'Hotkey ID'),
            editorFocusKeys: t(this.translate, this.locale, 'Editor focus keys'),
            editorFocusKeysDesc: t(this.translate, this.locale, 'These keys are handled only while the command editor itself is focused.'),
            searchFocusKeys: t(this.translate, this.locale, 'Search focus keys'),
            searchFocusKeysDesc: t(this.translate, this.locale, 'These keys keep sending and running available while Monaco search is open.'),
            codeBlockRun: t(this.translate, this.locale, 'Code block run commands'),
            codeBlockRunDesc: t(this.translate, this.locale, 'Customize python/bash/powershell under commandEditor in config.yaml (keys: python, bash, powershell). Platform defaults apply on Windows vs macOS/Linux. Below is the effective merged configuration.'),
            codeBlockAliases: t(this.translate, this.locale, 'Markdown fence tag → interpreter family (python / bash / powershell)'),
            codeBlockBg: t(this.translate, this.locale, 'BG mode: spawn command string; script body is written to stdin'),
            codeBlockTf: t(this.translate, this.locale, 'TF mode: command sent to terminal; {file} = quoted temp script path'),
        }
        this.editorShortcuts = EDITOR_SHORTCUTS.map(shortcut => ({
            ...shortcut,
            name: t(this.translate, this.locale, shortcut.name),
            detail: t(this.translate, this.locale, shortcut.detail),
        }))
        this.findShortcuts = FIND_SHORTCUTS.map(shortcut => ({
            ...shortcut,
            name: t(this.translate, this.locale, shortcut.name),
            detail: t(this.translate, this.locale, shortcut.detail),
        }))
    }

    get globalShortcuts (): GlobalShortcutRow[] {
        const hotkeys = this.config.store.hotkeys as Record<string, string[] | string[][] | undefined> | undefined
        return GLOBAL_SHORTCUTS.map(shortcut => ({
            ...shortcut,
            name: t(this.translate, this.locale, shortcut.name),
            keys: this.formatHotkeys(hotkeys?.[shortcut.id]),
        }))
    }

    get codeBlockRunConfigJson (): string {
        return formatCodeBlockRunConfigForDisplay(this.config.store.commandEditor)
    }

    private formatHotkeys (value: string[] | string[][] | undefined): string {
        if (!value?.length) {
            return t(this.translate, this.locale, 'Unassigned')
        }

        if (typeof value[0] === 'string') {
            return (value as string[]).join(' ')
        }

        return (value as string[][])
            .map(sequence => sequence.join(' '))
            .join(', ')
    }
}
