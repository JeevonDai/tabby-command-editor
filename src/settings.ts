import { Component, Injectable } from '@angular/core'
import { ConfigService, TranslateService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

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
    { id: 'run-command-editor-python', name: 'Run code block (legacy)' },
    { id: 'toggle-command-editor-python-log', name: 'Toggle block run mode' },
    { id: 'open-command-editor-python-log', name: 'Open Python log location' },
]

const EDITOR_SHORTCUTS: ShortcutRow[] = [
    { keys: 'Enter / F8', name: 'Send', detail: 'Send current line or selection (blocked inside code blocks)' },
    { keys: 'F7', name: 'Go to next highlighted symbol', detail: 'Monaco built-in (plugin does not bind F7)' },
    { keys: 'F9', name: 'Loop or Run', detail: 'Comments stripped; code block: run (terminal file or background per F10); line: send and move down (comment-only/blank: move only); selection: loop (interval × count)' },
    { keys: 'F10', name: 'Block run mode', detail: 'Toggle: terminal temp file vs background (stdout→terminal, stderr→log)' },
    { keys: 'Shift+Enter', name: 'Save', detail: 'Save current document' },
    { keys: 'Alt+Enter', name: 'New line', detail: 'Insert a line without sending' },
    { keys: 'Ctrl+/', name: 'Line comment', detail: 'Toggle line comment' },
    { keys: 'Ctrl+Shift+/', name: 'Markdown comment', detail: 'Toggle markdown block comment' },
    { keys: 'Ctrl+\\', name: 'Fold', detail: 'Toggle code folding' },
    { keys: 'Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A', name: 'Clipboard', detail: 'Copy, paste, cut, select all' },
]

const FIND_SHORTCUTS: ShortcutRow[] = [
    { keys: 'Enter / F7', name: 'Find next', detail: 'Next search match while find widget is open' },
    { keys: 'Shift+Enter / Shift+F7', name: 'Find previous', detail: 'Previous search match while find widget is open' },
    { keys: 'F8 / Ctrl+Enter', name: 'Send', detail: 'Send current line while search is open (blocked inside code blocks)' },
    { keys: 'F9 / Ctrl+Shift+Enter', name: 'Loop or Run', detail: 'Same as editor F9' },
    { keys: 'F10', name: 'Block run mode', detail: 'Toggle: terminal temp file vs background (stdout→terminal, stderr→log)' },
]

@Injectable()
export class CommandEditorSettingsTabProvider extends SettingsTabProvider {
    id = 'command-editor'
    icon = 'fas fa-edit'
    title: string
    weight = 10
    prioritized = false

    constructor (translate: TranslateService) {
        super()
        this.title = translate.instant('Command editor')
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
                <h3>{{ 'Global hotkeys' | translate }}</h3>
                <p class="text-muted">
                    {{ 'These are Tabby-level hotkeys registered by the command editor. Edit their bindings in Settings -> Hotkeys.' | translate }}
                </p>
                <div class="command-editor-shortcut-table">
                    <div class="command-editor-shortcut-row header">
                        <span>{{ 'Action' | translate }}</span>
                        <span>{{ 'Current binding' | translate }}</span>
                        <span>Hotkey ID</span>
                    </div>
                    <div class="command-editor-shortcut-row" *ngFor="let shortcut of globalShortcuts">
                        <span>{{ shortcut.name | translate }}</span>
                        <span><kbd>{{ shortcut.keys }}</kbd></span>
                        <code>{{ shortcut.id }}</code>
                    </div>
                </div>
            </section>

            <section>
                <h3>{{ 'Editor focus keys' | translate }}</h3>
                <p class="text-muted">
                    {{ 'These keys are handled only while the command editor itself is focused.' | translate }}
                </p>
                <div class="command-editor-shortcut-table compact">
                    <div class="command-editor-shortcut-row" *ngFor="let shortcut of editorShortcuts">
                        <span><kbd>{{ shortcut.keys }}</kbd></span>
                        <strong>{{ shortcut.name | translate }}</strong>
                        <span class="text-muted">{{ shortcut.detail | translate }}</span>
                    </div>
                </div>
            </section>

            <section>
                <h3>{{ 'Search focus keys' | translate }}</h3>
                <p class="text-muted">
                    {{ 'These keys keep sending and running available while Monaco search is open.' | translate }}
                </p>
                <div class="command-editor-shortcut-table compact">
                    <div class="command-editor-shortcut-row" *ngFor="let shortcut of findShortcuts">
                        <span><kbd>{{ shortcut.keys }}</kbd></span>
                        <strong>{{ shortcut.name | translate }}</strong>
                        <span class="text-muted">{{ shortcut.detail | translate }}</span>
                    </div>
                </div>
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
    editorShortcuts = EDITOR_SHORTCUTS
    findShortcuts = FIND_SHORTCUTS

    constructor (private config: ConfigService) {}

    get globalShortcuts (): GlobalShortcutRow[] {
        const hotkeys = this.config.store.hotkeys as Record<string, string[] | string[][] | undefined> | undefined
        return GLOBAL_SHORTCUTS.map(shortcut => ({
            ...shortcut,
            keys: this.formatHotkeys(hotkeys?.[shortcut.id]),
        }))
    }

    private formatHotkeys (value: string[] | string[][] | undefined): string {
        if (!value?.length) {
            return 'Unassigned'
        }

        if (typeof value[0] === 'string') {
            return (value as string[]).join(' ')
        }

        return (value as string[][])
            .map(sequence => sequence.join(' '))
            .join(', ')
    }
}
