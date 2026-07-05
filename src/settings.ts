import { ChangeDetectorRef, Component, Injectable } from '@angular/core'
import { ConfigService, LocaleService, TranslateService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import {
    CodeBlockRunSettings,
    resolveCodeBlockRunSettings,
    ScriptLanguage,
} from './codeBlockRunConfig'
import { t } from './locale'

interface LanguageAliasRow {
    alias: string
    language: ScriptLanguage
}

interface RunCommandRow {
    language: ScriptLanguage
    terminalCommand: string
}

interface WritableConfigNode extends Record<string, unknown> {
    __setValue?: (key: string, value: unknown) => void
}

const DEFAULT_SCRIPT_LANGUAGE = 'python'

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
    { id: 'bind-command-editor-python-api', name: 'Bind current terminal for Python API' },
]

const EDITOR_SHORTCUTS: ShortcutRow[] = [
    { keys: 'Right-click', name: 'Right-click (when enabled in settings)', detail: 'Send the line under the mouse cursor to the terminal; replaces the context menu' },
    { keys: 'Tab', name: 'Complete or indent', detail: 'Accept the suggested command from anywhere in this file; indent when no suggestion is available' },
    { keys: 'Shift+Tab', name: 'Next completion or outdent', detail: 'Cycle command-history suggestions; outdent when no suggestion is available' },
    { keys: 'Enter / F8', name: 'Send', detail: 'Send current line or selection (blocked inside code blocks)' },
    { keys: 'F6', name: 'Stop', detail: 'Stop active loop sends' },
    { keys: 'F7', name: 'Go to next highlighted symbol', detail: 'Monaco built-in (plugin does not bind F7)' },
    { keys: 'F9', name: 'Loop or Run', detail: 'Comments stripped; code block: run as a terminal file; line: send and move down; selection: loop' },
    { keys: 'F10', name: 'Bind Python API', detail: 'Bind the current terminal as the Python API send/read target' },
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
    { keys: 'F6', name: 'Stop', detail: 'Stop active loop sends' },
    { keys: 'F8 / Ctrl+Enter', name: 'Send', detail: 'Send current line while search is open (blocked inside code blocks)' },
    { keys: 'F9 / Ctrl+Shift+Enter', name: 'Loop or Run', detail: 'Same as editor F9; in find mode sends match line and moves to the next line' },
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
                <h3>{{ labels.editorOptions }}</h3>
                <div class="command-editor-option-row">
                    <label class="command-editor-option-toggle">
                        <input
                            type="checkbox"
                            [checked]="rightClickSendLine"
                            (change)="onRightClickSendLineChange($event)"
                        />
                        <span>{{ labels.rightClickSendLine }}</span>
                    </label>
                    <p class="text-muted">{{ labels.rightClickSendLineDesc }}</p>
                </div>
            </section>

            <section>
                <h3>{{ labels.pythonApi }}</h3>
                <p class="text-muted">{{ labels.pythonApiDesc }}</p>
                <div class="command-editor-python-api-table">
                    <div><code>tabby.send(text)</code><span>{{ labels.apiSend }}</span></div>
                    <div><code>tabby.mark()</code><span>{{ labels.apiMark }}</span></div>
                    <div><code>tabby.expect(pattern, timeout=5, since=None, flags=0)</code><span>{{ labels.apiExpect }}</span></div>
                    <div><code>tabby.read(timeout=0)</code><span>{{ labels.apiRead }}</span></div>
                    <div><code>tabby.tail(last=4096)</code><span>{{ labels.apiTail }}</span></div>
                    <div><code>tabby.clear()</code><span>{{ labels.apiClear }}</span></div>
                </div>
                <pre class="command-editor-python-api-example">mark = tabby.mark()
tabby.send("git version")
match = tabby.expect(r"git version\s+([0-9][^\n]*)", timeout=5, since=mark)
print("version:", match.group(1))</pre>
            </section>

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

                <div class="command-editor-run-config-grid">
                    <div class="command-editor-config-panel">
                        <div class="command-editor-config-panel-header">
                            <div>
                                <h4>{{ labels.languageAliases }}</h4>
                                <p class="text-muted">{{ labels.codeBlockAliases }}</p>
                            </div>
                            <button class="btn btn-sm btn-secondary" type="button" (click)="addAlias()">
                                <i class="fas fa-plus"></i> {{ labels.add }}
                            </button>
                        </div>

                        <div class="command-editor-list alias-list">
                            <div class="command-editor-list-row list-header">
                                <span>{{ labels.fenceAlias }}</span>
                                <span>{{ labels.language }}</span>
                                <span></span>
                            </div>
                            <div class="command-editor-list-row" *ngFor="let row of aliasRows; let i = index; trackBy: trackByIndex">
                                <input
                                    class="form-control form-control-sm"
                                    type="text"
                                    [(ngModel)]="row.alias"
                                    [attr.aria-label]="labels.fenceAlias"
                                    (ngModelChange)="markDirty()"
                                >
                                <select
                                    class="form-control form-control-sm"
                                    [(ngModel)]="row.language"
                                    [attr.aria-label]="labels.language"
                                    (ngModelChange)="markDirty()"
                                >
                                    <option *ngFor="let language of scriptLanguages" [ngValue]="language">{{ language }}</option>
                                </select>
                                <button
                                    class="btn btn-sm btn-outline-danger icon-button"
                                    type="button"
                                    [attr.aria-label]="labels.remove"
                                    [title]="labels.remove"
                                    (click)="removeAlias(i)"
                                >
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </div>

                        <button class="btn btn-sm btn-link config-fill-button" type="button" (click)="fillDefaultAliases()">
                            {{ labels.fillDefaultAliases }}
                        </button>
                    </div>

                    <div class="command-editor-config-panel">
                        <div class="command-editor-config-panel-header">
                            <div>
                                <h4>{{ labels.runCommands }}</h4>
                                <p class="text-muted">{{ labels.runCommandsDesc }}</p>
                            </div>
                            <button class="btn btn-sm btn-secondary header-action" type="button" (click)="addCommand()">
                                <i class="fas fa-plus"></i><span>{{ labels.addInterpreter }}</span>
                            </button>
                        </div>

                        <div class="command-editor-list command-list">
                            <div class="command-editor-list-row list-header">
                                <span>{{ labels.language }}</span>
                                <span>{{ labels.foregroundCommand }}</span>
                                <span></span>
                            </div>
                            <div class="command-editor-list-row" *ngFor="let row of commandRows; let i = index; trackBy: trackByIndex">
                                <input
                                    class="form-control form-control-sm"
                                    type="text"
                                    [(ngModel)]="row.language"
                                    [attr.aria-label]="labels.language"
                                    (ngModelChange)="markDirty()"
                                >
                                <input
                                    class="form-control form-control-sm command-input"
                                    type="text"
                                    [(ngModel)]="row.terminalCommand"
                                    [attr.aria-label]="labels.foregroundCommand + ': ' + row.language"
                                    (ngModelChange)="markDirty()"
                                >
                                <button
                                    class="btn btn-sm btn-outline-danger icon-button"
                                    type="button"
                                    [attr.aria-label]="labels.remove"
                                    [title]="labels.remove"
                                    (click)="removeCommand(i)"
                                >
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </div>

                        <div class="command-editor-command-help text-muted">
                            <span>{{ labels.codeBlockTf }}</span>
                        </div>
                        <button class="btn btn-sm btn-link config-fill-button" type="button" (click)="fillDefaultCommands()">
                            {{ labels.fillDefaultCommands }}
                        </button>
                    </div>
                </div>

                <div class="command-editor-config-actions">
                    <span class="text-danger" *ngIf="saveError">{{ saveError }}</span>
                    <span class="text-success" *ngIf="saveMessage">{{ saveMessage }}</span>
                    <button class="btn btn-primary" type="button" [disabled]="saving || !dirty" (click)="saveCodeBlockConfig()">
                        <i class="fas fa-save"></i> {{ saving ? labels.saving : labels.saveConfig }}
                    </button>
                </div>
            </section>
        </div>
    `,
    styles: [`
        .command-editor-settings {
            display: flex;
            flex-direction: column;
            container-name: command-editor-settings;
            container-type: inline-size;
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

        .command-editor-python-api-table > div {
            display: grid;
            grid-template-columns: minmax(260px, 0.9fr) minmax(280px, 1.3fr);
            gap: 16px;
            padding: 7px 0;
            border-top: 1px solid var(--bs-border-color, rgba(255,255,255,.12));
            font-size: 13px;
        }

        .command-editor-python-api-example {
            margin-top: 12px;
            padding: 12px;
            border-radius: 5px;
            background: var(--bs-tertiary-bg, rgba(0,0,0,.2));
            white-space: pre-wrap;
        }

        .command-editor-option-row {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .command-editor-option-toggle {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            margin: 0;
            cursor: pointer;
            user-select: none;
        }

        .command-editor-option-toggle input {
            width: 16px;
            height: 16px;
            margin: 0;
            cursor: pointer;
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

        .command-editor-run-config-grid {
            display: grid;
            grid-template-columns: minmax(320px, 0.8fr) minmax(520px, 1.4fr);
            gap: 16px;
            align-items: start;
        }

        .command-editor-config-panel {
            min-width: 0;
            padding: 14px;
            border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.14));
            border-radius: 4px;
        }

        .command-editor-config-panel-header {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: flex-start;
            justify-content: space-between;
            min-height: 54px;
            margin-bottom: 10px;
        }

        .command-editor-config-panel-header .header-action {
            display: inline-flex;
            flex: 0 0 auto;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        }

        .command-editor-config-panel h4 {
            margin: 0 0 4px;
            font-size: 15px;
            font-weight: 600;
        }

        .command-editor-config-panel p {
            margin: 0;
            font-size: 12px;
        }

        .command-editor-list {
            display: grid;
            gap: 6px;
        }

        .command-editor-list-row {
            display: grid;
            gap: 8px;
            align-items: center;
        }

        .alias-list .command-editor-list-row {
            grid-template-columns: minmax(100px, 1fr) minmax(120px, 1fr) 32px;
        }

        .command-list .command-editor-list-row {
            grid-template-columns: minmax(90px, 0.55fr) minmax(240px, 1.6fr) 32px;
        }

        .command-editor-list-row.list-header {
            padding: 0 2px 2px;
            color: var(--bs-secondary-color, #888);
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
        }

        .command-editor-list-row code {
            color: var(--bs-body-color, #ddd);
        }

        .command-input {
            min-width: 0;
            font-family: monospace;
        }

        .icon-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 31px;
            padding-left: 0;
            padding-right: 0;
        }

        .config-fill-button {
            margin-top: 10px;
            padding-left: 0;
            padding-right: 0;
        }

        .command-editor-command-help {
            display: grid;
            grid-template-columns: minmax(90px, 0.55fr) minmax(240px, 1.6fr) 32px;
            gap: 8px;
            margin-top: 8px;
            font-size: 11px;
        }

        .command-editor-command-help span:first-child {
            grid-column: 2;
        }

        .command-editor-config-actions {
            display: flex;
            min-height: 38px;
            gap: 12px;
            align-items: center;
            justify-content: flex-end;
            margin-top: 12px;
            font-size: 13px;
        }

        @container command-editor-settings (max-width: 900px) {
            .command-editor-run-config-grid {
                grid-template-columns: 1fr;
            }
        }

        @container command-editor-settings (max-width: 620px) {
            .command-editor-shortcut-row,
            .command-editor-shortcut-table.compact .command-editor-shortcut-row {
                grid-template-columns: 1fr;
                gap: 5px;
            }

            .command-list .command-editor-list-row {
                grid-template-columns: 1fr;
            }

            .alias-list .command-editor-list-row:not(.list-header) {
                grid-template-columns: minmax(90px, 1fr) minmax(110px, 1fr) 32px;
            }

            .command-editor-command-help,
            .command-editor-list-row.list-header.command-editor-list-row {
                display: none;
            }

            .command-editor-config-actions {
                align-items: stretch;
                flex-direction: column;
            }

            .command-editor-config-actions .btn {
                align-self: flex-end;
            }
        }
    `],
})
export class CommandEditorSettingsTabComponent {
    labels: Record<string, string> = {}
    editorShortcuts: ShortcutRow[] = []
    findShortcuts: ShortcutRow[] = []
    get scriptLanguages (): ScriptLanguage[] {
        return this.commandRows
            .map(row => row.language.trim().toLowerCase())
            .filter(Boolean)
    }
    aliasRows: LanguageAliasRow[] = []
    commandRows: RunCommandRow[] = []
    dirty = false
    saving = false
    saveError = ''
    saveMessage = ''

    constructor (
        private config: ConfigService,
        private translate: TranslateService,
        private locale: LocaleService,
        private cdr: ChangeDetectorRef,
    ) {
        this.loadCodeBlockConfig()
        this.refreshLocalizedContent()
        this.locale.localeChanged$.subscribe(() => {
            this.refreshLocalizedContent()
            this.cdr.markForCheck()
        })
    }

    private refreshLocalizedContent (): void {
        this.labels = {
            editorOptions: t(this.translate, this.locale, 'Editor options'),
            rightClickSendLine: t(this.translate, this.locale, 'Right-click to send line'),
            rightClickSendLineDesc: t(this.translate, this.locale, 'When enabled, right-click in the editor sends the command on that line to the terminal instead of opening the context menu.'),
            pythonApi: t(this.translate, this.locale, 'Python API'),
            pythonApiDesc: t(this.translate, this.locale, 'Select a target in the editor toolbar or press F10 to bind the current terminal. Only tabby.send() writes to the bound terminal.'),
            apiSend: t(this.translate, this.locale, 'Send text as one or more commands to the bound terminal.'),
            apiMark: t(this.translate, this.locale, 'Return the current absolute position in the terminal receive buffer.'),
            apiExpect: t(this.translate, this.locale, 'Wait for a regular-expression match and return a Python re.Match object.'),
            apiRead: t(this.translate, this.locale, 'Read new terminal text since the current cursor; optionally wait for data.'),
            apiTail: t(this.translate, this.locale, 'Return the last N characters without moving the current cursor.'),
            apiClear: t(this.translate, this.locale, 'Move the current cursor to the end without deleting the receive buffer.'),
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
            codeBlockRunDesc: t(this.translate, this.locale, 'Configure runnable Markdown fence aliases and terminal file commands. Save writes these values under commandEditor in config.yaml.'),
            languageAliases: t(this.translate, this.locale, 'Language aliases'),
            codeBlockAliases: t(this.translate, this.locale, 'Markdown fence tag → interpreter'),
            runCommands: t(this.translate, this.locale, 'Run commands'),
            runCommandsDesc: t(this.translate, this.locale, 'Configure the terminal file command for each interpreter.'),
            fenceAlias: t(this.translate, this.locale, 'Fence alias'),
            language: t(this.translate, this.locale, 'Language'),
            foregroundCommand: t(this.translate, this.locale, 'Foreground command'),
            codeBlockTf: t(this.translate, this.locale, 'TF mode: command sent to terminal; {file} = quoted temp script path'),
            add: t(this.translate, this.locale, 'Add'),
            addInterpreter: t(this.translate, this.locale, 'Add interpreter'),
            remove: t(this.translate, this.locale, 'Remove'),
            fillDefaultAliases: t(this.translate, this.locale, 'Fill missing default aliases'),
            fillDefaultCommands: t(this.translate, this.locale, 'Fill default commands'),
            saveConfig: t(this.translate, this.locale, 'Save and apply'),
            saving: t(this.translate, this.locale, 'Saving...'),
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

    get rightClickSendLine (): boolean {
        return this.config.store.commandEditor?.rightClickSendLine === true
    }

    onRightClickSendLineChange (event: Event): void {
        const checked = (event.target as HTMLInputElement).checked
        if (!this.config.store.commandEditor) {
            return
        }
        this.config.store.commandEditor.rightClickSendLine = checked
        void this.config.save()
    }

    get globalShortcuts (): GlobalShortcutRow[] {
        const hotkeys = this.config.store.hotkeys as Record<string, string[] | string[][] | undefined> | undefined
        return GLOBAL_SHORTCUTS.map(shortcut => ({
            ...shortcut,
            name: t(this.translate, this.locale, shortcut.name),
            keys: this.formatHotkeys(hotkeys?.[shortcut.id]),
        }))
    }

    addAlias (): void {
        this.aliasRows.push({ alias: '', language: this.scriptLanguages[0] ?? DEFAULT_SCRIPT_LANGUAGE })
        this.markDirty()
    }

    addCommand (): void {
        this.commandRows.push({ language: '', terminalCommand: '' })
        this.markDirty()
    }

    removeCommand (index: number): void {
        this.commandRows.splice(index, 1)
        this.markDirty()
    }

    removeAlias (index: number): void {
        this.aliasRows.splice(index, 1)
        this.markDirty()
    }

    fillDefaultAliases (): void {
        const defaults = resolveCodeBlockRunSettings(undefined)
        const existing = new Set(this.aliasRows.map(row => row.alias.trim().toLowerCase()))
        for (const [alias, language] of Object.entries(defaults.languageAliases)) {
            if (!existing.has(alias)) {
                this.aliasRows.push({ alias, language })
            }
        }
        this.markDirty()
    }

    fillDefaultCommands (): void {
        const defaults = resolveCodeBlockRunSettings(undefined)
        for (const row of this.commandRows) {
            row.terminalCommand = defaults.terminalCommands[row.language]
        }
        this.markDirty()
    }

    markDirty (): void {
        this.dirty = true
        this.saveError = ''
        this.saveMessage = ''
    }

    async saveCodeBlockConfig (): Promise<void> {
        if (this.saving) {
            return
        }

        const aliases: Record<string, ScriptLanguage> = {}
        for (const row of this.aliasRows) {
            const alias = row.alias.trim().toLowerCase()
            const language = row.language.trim().toLowerCase()
            if (!alias) {
                this.saveError = t(this.translate, this.locale, 'Language aliases cannot be empty.')
                return
            }
            if (!language) {
                this.saveError = t(this.translate, this.locale, 'Interpreter name cannot be empty.')
                return
            }
            if (aliases[alias]) {
                this.saveError = t(this.translate, this.locale, 'Language alias "{alias}" is duplicated.', { alias })
                return
            }
            aliases[alias] = language
        }

        const terminalCommands: Record<string, string> = {}
        for (const row of this.commandRows) {
            const language = row.language.trim().toLowerCase()
            const terminalCommand = row.terminalCommand.trim()
            if (!language) {
                this.saveError = t(this.translate, this.locale, 'Interpreter name cannot be empty.')
                return
            }
            if (terminalCommands[language]) {
                this.saveError = t(this.translate, this.locale, 'Interpreter "{language}" is duplicated.', { language })
                return
            }
            if (!terminalCommand) {
                this.saveError = t(this.translate, this.locale, 'A command is required for {language}.', {
                    language,
                })
                return
            }
            terminalCommands[language] = terminalCommand
        }

        this.saving = true
        this.saveError = ''
        this.saveMessage = ''
        try {
            const commandEditor = this.config.store.commandEditor as WritableConfigNode | undefined
            if (!commandEditor) {
                throw new Error('commandEditor configuration is unavailable')
            }
            this.setConfigValue(commandEditor, 'codeBlockLanguageAliases', { ...aliases })
            this.setConfigValue(commandEditor, 'codeBlockTerminalCommands', { ...terminalCommands })
            await this.config.save()
            // ConfigProxy may still expose its pre-save snapshot here. Reload the
            // persisted YAML before rebuilding the form so it reflects disk state.
            await this.config.load()
            this.loadCodeBlockConfig()
            this.dirty = false
            this.saveMessage = t(this.translate, this.locale, 'Code block run configuration saved and applied.')
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            console.error('Failed to save code block run configuration:', error)
            this.saveError = detail
                ? `${t(this.translate, this.locale, 'Failed to save code block run configuration.')} ${detail}`
                : t(this.translate, this.locale, 'Failed to save code block run configuration.')
        } finally {
            this.saving = false
            this.cdr.markForCheck()
        }
    }

    trackByIndex (index: number): number {
        return index
    }

    trackByLanguage (_index: number, row: RunCommandRow): ScriptLanguage {
        return row.language
    }

    private setConfigValue (node: WritableConfigNode, key: string, value: unknown): void {
        if (typeof node.__setValue === 'function') {
            node.__setValue(key, value)
            return
        }
        node[key] = value
    }

    private loadCodeBlockConfig (): void {
        const settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(this.config.store.commandEditor)
        this.aliasRows = Object.entries(settings.languageAliases).map(([alias, language]) => ({
            alias,
            language,
        }))
        const languages = new Set([
            ...Object.keys(settings.terminalCommands),
            ...Object.values(settings.languageAliases),
        ])
        this.commandRows = [...languages].map(language => ({
            language,
            terminalCommand: settings.terminalCommands[language],
        }))
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
