import { Injectable, NgZone } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, ConfigService, LocaleService, NotificationsService, PlatformService, SplitTabComponent, ThemesService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { splitMarkdownCommentNewline, stripComments, toggleCodeFence, toggleSmartComment } from '../commandComments'
import { COMMAND_EDITOR_LANGUAGE, defineCommandEditorThemeColors, registerCommandEditorLanguage } from '../commandEditorLanguage'
import { registerMarkdownHeadingFeatures, showHeadingOutlinePicker, closeHeadingOutlinePicker, pruneQuickAccessProviders } from '../commandOutline'
import {
    CodeExecution,
    decodeTabbySendLine,
    findRunnableCodeBlockAtCursor,
    findRunnableCodeBlockAtLine,
    resolveScriptLanguage,
    resolveScriptTerminalPayload,
    runCodeBlock,
} from '../pythonCodeBlockRunner'
import { CodeBlockRunSettings, resolveCodeBlockRunSettings } from '../codeBlockRunConfig'
import { t } from '../locale'
import { findCommandHistorySuggestions } from '../commandHistoryCompletion'
// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

const STYLE_ID = 'tabby-command-editor-panel-style'
const BAR_ID = 'tabby-command-editor-panel-bar'
const BODY_CLASS = 'tabby-command-editor-panel-enabled'
const BROADCAST_BAR_ID = 'tabby-broadcast-input-bar'
const TAB_CONTENT_SELECTOR = 'app-root > .content > .content'
const PANEL_SIZE_VAR = '--tabby-command-editor-panel-size'
const CONTENT_TAB_SELECTOR = 'app-root .content > .content > .content-tab.content-tab-active, app-root > .content > .content > .content-tab.content-tab-active'
const PLUGIN_BUILD_ID = '20260530-loop6'

type SendLineIntervalUnit = 'min' | 's' | 'ms'
const SEND_LINE_INTERVAL_UNITS: SendLineIntervalUnit[] = ['min', 's', 'ms']
const LOOP_JOB_COLORS = [
    { border: '#4da3ff', bg: 'rgba(77, 163, 255, 0.14)', accent: '#4da3ff' },
    { border: '#4ec9b0', bg: 'rgba(78, 201, 176, 0.14)', accent: '#4ec9b0' },
    { border: '#c586c0', bg: 'rgba(197, 134, 192, 0.14)', accent: '#c586c0' },
    { border: '#dcdcaa', bg: 'rgba(220, 220, 170, 0.14)', accent: '#dcdcaa' },
    { border: '#f48771', bg: 'rgba(244, 135, 113, 0.14)', accent: '#f48771' },
    { border: '#569cd6', bg: 'rgba(86, 156, 214, 0.14)', accent: '#569cd6' },
] as const

type PanelPosition = 'bottom' | 'right'

interface LoopSendJob {
    id: number
    terminal: BaseTerminalTabComponent<any>
    terminalLabel: string
    lines: string[]
    delayMs: number
    loopCount: number
    colorIndex: number
    rootEl: HTMLElement
    labelEl: HTMLElement
    previewEl: HTMLElement
}

interface TabbyRunJob {
    id: number
    terminal: BaseTerminalTabComponent<any>
    terminalLabel: string
    execution: CodeExecution
    outputSubscription: Subscription
    rootEl: HTMLElement
    labelEl: HTMLElement
    previewEl: HTMLElement
}

interface PanelState {
    root: HTMLElement
    resizeHandle: HTMLElement
    editorHost: HTMLElement
    editor: monaco.editor.IStandaloneCodeEditor
    fileHistoryButton: HTMLButtonElement
    fileHistoryMenu: HTMLElement
    sendIntervalInput: HTMLInputElement
    sendIntervalUnitSelect: HTMLSelectElement
    sendLoopCountInput: HTMLInputElement
    loopSendBtn: HTMLButtonElement
    batchStatusContainer: HTMLElement
    filePath: string | null
    visible: boolean
    panelSizePx: number
}

@Injectable()
export class CommandEditorPanelService {
    private static languageFeaturesRegistered = false

    private panel: PanelState | null = null
    private pendingLastOpenedFile: string | null = null
    private editorFocused = false
    private layoutAdjusted = false
    private tabAreaObserver: ResizeObserver | null = null
    private activeTabSubscription: Subscription | null = null
    private nextLoopSendJobId = 0
    private nextTabbyRunJobId = 0
    private nextLoopSendColorIndex = 0
    private readonly loopSendJobs = new Map<number, LoopSendJob>()
    private readonly tabbyRunJobs = new Map<number, TabbyRunJob>()
    private readonly terminalLoopColors = new Map<BaseTerminalTabComponent<any>, number>()
    private savedEditorSelection: monaco.Selection | null = null
    private symbolHighlightIds: string[] = []
    private targetTerminalTab: BaseTerminalTabComponent<any> | null = null
    private suppressResizeHandler = false
    private commandHistoryCompletionIndex = 0
    private commandHistoryCompletionSignature: string | null = null
    private commandHistoryCompletionProvider: monaco.IDisposable | null = null
    private copiedWholeLineText: string | null = null
    private panelResizeDrag: {
        active: boolean
        startPos: number
        startSize: number
    } | null = null
    private readonly onPanelResizeMove = (event: MouseEvent): void => {
        if (!this.panelResizeDrag?.active || !this.panel?.visible) {
            return
        }

        const host = this.getTabContentArea()
        if (!host) {
            return
        }

        const position = this.getPanelPosition()
        const delta = position === 'right'
            ? this.panelResizeDrag.startPos - event.clientX
            : this.panelResizeDrag.startPos - event.clientY
        const nextSize = this.clampPanelSize(this.panelResizeDrag.startSize + delta, host, position)
        this.setPanelSize(this.panel, nextSize)
        this.syncPanelLayout(this.panel)
    }
    private readonly onPanelResizeEnd = (): void => {
        if (!this.panelResizeDrag?.active) {
            return
        }

        this.panelResizeDrag.active = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        this.persistPanelSize()
    }
    private readonly onPanelHotkeyCapture = (event: KeyboardEvent): void => {
        if (event.type !== 'keydown' || event.repeat) {
            return
        }

        const action = this.resolveCapturedPanelHotkeyAction(event)
        if (!action) {
            return
        }

        // xterm handles keydown on the focused terminal before Tabby hotkey bubble runs,
        // so Ctrl+letter shortcuts would reach the serial session unless we swallow them here.
        event.preventDefault()
        event.stopImmediatePropagation()
        void action()
    }
    private readonly onDocumentClick = (event: MouseEvent): void => {
        const state = this.panel
        if (!state?.visible) {
            return
        }

        const target = event.target as Node | null
        if (!target || state.fileHistoryButton.contains(target) || state.fileHistoryMenu.contains(target)) {
            return
        }

        this.closeFileHistoryMenu(state)
    }

    private resolveCapturedPanelHotkeyAction (event: KeyboardEvent): (() => void | Promise<void>) | null {
        if (this.matchesConfiguredHotkey(event, 'toggle-command-editor-panel')) {
            return () => this.togglePanel()
        }
        if (this.matchesConfiguredHotkey(event, 'find-in-command-editor')) {
            return () => this.openFindWidget()
        }
        if (this.matchesConfiguredHotkey(event, 'open-command-editor-file')) {
            return () => this.openFile()
        }
        if (this.matchesConfiguredHotkey(event, 'save-command-editor-file')) {
            return () => this.saveFile()
        }
        if (this.matchesConfiguredHotkey(event, 'open-command-editor-outline')) {
            return () => this.openOutlinePicker()
        }
        return null
    }

    private readonly onDocumentKeyCapture = (event: KeyboardEvent): void => {
        if (!this.panel?.visible) {
            return
        }

        const target = event.target as Node | null
        if (!target || !this.panel.editorHost.contains(target)) {
            return
        }

        const findWidgetVisible = this.isFindWidgetVisible()

        if (!this.editorFocused && !findWidgetVisible) {
            return
        }

        if (
            event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && !event.shiftKey
            && event.code === 'KeyA'
            && !findWidgetVisible
            && !this.isMonacoOverlayInput(target)
        ) {
            event.preventDefault()
            event.stopImmediatePropagation()
            toggleCodeFence(this.panel.editor)
            return
        }

        if (findWidgetVisible) {
            if (event.key === 'F7') {
                event.preventDefault()
                event.stopImmediatePropagation()
                this.runFindWidgetMatch(!event.shiftKey)
                return
            }
            if (event.key === 'F8') {
                event.preventDefault()
                event.stopImmediatePropagation()
                this.sendFromPanel(undefined, true)
                return
            }
            if (event.key === 'F9') {
                event.preventDefault()
                event.stopImmediatePropagation()
                void this.loopOrRun()
                return
            }
            if (event.key === 'F6') {
                event.preventDefault()
                event.stopImmediatePropagation()
                this.cancelLoopSend()
                return
            }
        }

        // Exact clipboard shortcuts use Tabby's bridge. Modified shortcuts such as
        // Ctrl+Alt+Enter stay native so Monaco can perform Replace All.
        if (
            !(event.ctrlKey || event.metaKey)
            || event.altKey
            || event.shiftKey
        ) {
            return
        }

        const key = event.key.toLowerCase()
        if (!['a', 'c', 'v', 'x'].includes(key)) {
            return
        }

        if (this.isMonacoOverlayInput(target)) {
            if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
                return
            }
            event.preventDefault()
            event.stopImmediatePropagation()
            this.handleInputClipboardShortcut(target, key)
            return
        }

        if (!this.editorFocused) {
            return
        }

        event.preventDefault()
        event.stopImmediatePropagation()
        const editor = this.panel.editor
        switch (key) {
            case 'c':
                this.copyFromEditor(editor)
                break
            case 'v':
                this.pasteIntoEditor(editor)
                break
            case 'x':
                this.cutFromEditor(editor)
                break
            case 'a':
                editor.trigger('keyboard', 'editor.action.selectAll', null)
                break
        }
    }
    private readonly onWindowBlur = (): void => {
        this.editorFocused = false
    }
    private readonly onVisibilityChange = (): void => {
        if (document.hidden) {
            this.editorFocused = false
        }
    }
    private readonly onWindowResize = (): void => {
        if (!this.panel?.visible || this.suppressResizeHandler) {
            return
        }
        this.applyPanelPosition(this.panel)
        this.syncPanelLayout(this.panel)
    }

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private locale: LocaleService,
        private zone: NgZone,
        private themes: ThemesService,
    ) {
        document.addEventListener('keydown', this.onPanelHotkeyCapture, true)
        document.addEventListener('keydown', this.onDocumentKeyCapture, true)
        document.addEventListener('click', this.onDocumentClick, true)
        document.addEventListener('visibilitychange', this.onVisibilityChange)
        window.addEventListener('blur', this.onWindowBlur)
        this.app.ready$.subscribe(() => {
            const filePath = this.config.store.commandEditor?.lastOpenedFile
            if (filePath && typeof filePath === 'string') {
                this.pendingLastOpenedFile = filePath
            }
        })
        this.config.changed$.subscribe(() => {
            const editor = this.panel?.editor
            if (editor) {
                this.applyEditorTheme()
                this.applyRightClickSendLineEditorOptions(editor)
                const model = editor.getModel()
                if (model) {
                    // Re-tokenize existing fences after runnable language aliases change.
                    monaco.editor.setModelLanguage(model, COMMAND_EDITOR_LANGUAGE)
                }
            }
        })
        this.themes.themeChanged$.subscribe(() => {
            requestAnimationFrame(() => this.applyEditorTheme())
        })
    }

    private readonly onEditorContextMenu = (event: MouseEvent): void => {
        if (!this.isRightClickSendLineEnabled()) {
            return
        }

        const editor = this.panel?.editor
        if (!editor) {
            return
        }

        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()

        const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
        const lineNumber = target?.position?.lineNumber
        if (!lineNumber) {
            return
        }

        this.zone.run(() => this.sendFromPanelAtLine(lineNumber))
    }

    private applyRightClickSendLineEditorOptions (editor: monaco.editor.IStandaloneCodeEditor): void {
        editor.updateOptions({
            contextmenu: !this.isRightClickSendLineEnabled(),
        })
    }

    private setupRightClickSendLine (
        editor: monaco.editor.IStandaloneCodeEditor,
        editorHost: HTMLElement,
    ): void {
        editorHost.addEventListener('contextmenu', this.onEditorContextMenu, true)
        this.applyRightClickSendLineEditorOptions(editor)
    }

    isOverlayVisible (_tab: BaseTerminalTabComponent<any>): boolean {
        return this.panel?.visible ?? false
    }

    isPanelVisible (): boolean {
        return this.panel?.visible ?? false
    }

    isEditorFocused (): boolean {
        return this.editorFocused && (this.panel?.visible ?? false)
    }

    openFindWidget (): void {
        const state = this.ensurePanel()
        if (!state.visible) {
            this.showPanel(state, this.getActiveTerminalTab())
        }
        state.editor.focus()
        state.editor.getAction('actions.find')?.run()
    }

    openOutlinePicker (): void {
        const state = this.ensurePanel()
        if (!state.visible) {
            this.showPanel(state, this.getActiveTerminalTab())
        }
        state.editor.focus()
        showHeadingOutlinePicker(state.editor, state.root)
    }

    /** Global hotkey: open the panel (if needed) and trigger Monaco's Go to Symbol. */
    openSymbolPicker (): void {
        const state = this.ensurePanel()
        const wasVisible = state.visible
        if (!wasVisible) {
            this.showPanel(state, this.getActiveTerminalTab())
        }

        const run = (): void => {
            state.editor.focus()
            state.editor.trigger('keyboard', 'editor.action.quickOutline', null)
        }

        if (wasVisible) {
            run()
        } else {
            // Wait one frame so the freshly mounted editor is laid out and focusable.
            requestAnimationFrame(run)
        }
    }

    getActiveTerminalTab (): BaseTerminalTabComponent<any> | null {
        const active = this.app.activeTab
        if (!active) {
            return null
        }
        return this.findTerminalInTab(active)
    }

    async togglePanel (terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        if (!terminal && !this.getActiveTerminalTab()) {
            this.notifications.info(t(this.translate, this.locale, 'No active terminal'))
            return
        }

        try {
            const state = this.ensurePanel()
            if (state.visible) {
                this.hidePanel(state)
                return
            }
            this.showPanel(state, terminal ?? this.getActiveTerminalTab())
        } catch (err) {
            console.error('[CommandEditorPanel] Failed to toggle panel:', err)
            this.notifications.error(t(this.translate, this.locale, 'Failed to open command editor panel'))
        }
    }

    async openFile (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.ensurePanel()
        if (!state.visible) {
            this.showPanel(state, this.getActiveTerminalTab())
        }

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const remote = require('@electron/remote')
        const result = await remote.dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
                { name: 'Text files', extensions: ['txt', 'sh', 'bash', 'md', 'json', 'yaml', 'yml', 'log', 'conf', 'cfg', 'ini', 'bat', 'ps1', 'py', 'js', 'ts'] },
                { name: 'All files', extensions: ['*'] },
            ],
        })
        if (result.canceled || !result.filePaths?.[0]) {
            return
        }

        const filePath = result.filePaths[0] as string
        this.loadFileFromPath(state, filePath)
        this.persistLastOpenedFile(filePath)
        state.editor.layout()
        state.editor.focus()
    }

    async saveFile (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.ensurePanel()
        if (!state.visible) {
            this.showPanel(state, this.getActiveTerminalTab())
        }

        let filePath = state.filePath
        if (!filePath) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const remote = require('@electron/remote')
            const result = await remote.dialog.showSaveDialog({})
            if (result.canceled || !result.filePath) {
                return
            }
            filePath = result.filePath
        }

        if (!filePath) {
            return
        }

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs')
        fs.writeFileSync(filePath, state.editor.getValue(), 'utf8')
        state.filePath = filePath
        this.persistLastOpenedFile(filePath)
        this.updateFileLabel(state)
        this.notifications.notice(t(this.translate, this.locale, 'File saved'))
    }

    async reloadFile (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.ensurePanel()
        if (!state.visible) {
            this.showPanel(state, this.getActiveTerminalTab())
        }

        const filePath = state.filePath ?? this.config.store.commandEditor?.lastOpenedFile ?? null
        if (!filePath || typeof filePath !== 'string') {
            this.notifications.info(t(this.translate, this.locale, 'No file open'))
            return
        }

        if (!this.loadFileFromPath(state, filePath)) {
            this.notifications.error(t(this.translate, this.locale, 'File not found'))
            return
        }

        this.persistLastOpenedFile(filePath)
        this.notifications.notice(t(this.translate, this.locale, 'File reloaded'))
        state.editor.layout()
        state.editor.focus()
    }

    sendFromPanel (_terminal?: BaseTerminalTabComponent<any> | null, forceLine?: boolean): void {
        const state = this.panel
        const terminalTab = _terminal ?? this.resolveTerminalForSend()
        if (!state?.visible || !terminalTab) {
            if (!terminalTab) {
                this.notifications.info(t(this.translate, this.locale, 'No active terminal'))
            }
            return
        }

        if (findRunnableCodeBlockAtCursor(state.editor, this.getCodeBlockRunSettings())) {
            this.notifications.info(t(this.translate, this.locale, 'Send is disabled inside code blocks — use Loop or Run (F9)'))
            return
        }

        const text = stripComments(this.getTextToSend(state.editor, forceLine))
        if (!text.trim()) {
            this.notifications.info(t(this.translate, this.locale, 'Nothing to send'))
            return
        }

        const lines = this.getNonEmptyCommandLines(text)
        if (lines.length === 1) {
            this.sendLineToTerminal(terminalTab, lines[0])
            return
        }

        // Even when the configured value is zero, leave enough time between selected
        // lines for a 115200-baud serial target to consume each submitted command.
        const delayMs = Math.max(10, this.readSendIntervalSec(state) * 1000)
        void this.sendCommandLinesWithInterval(terminalTab, lines, delayMs).catch(error => {
            console.error('[CommandEditorPanel] Multi-line send failed:', error)
            this.notifications.error(t(this.translate, this.locale, 'Loop send failed'))
        })
    }

    sendFromPanelAtLine (lineNumber: number, _terminal?: BaseTerminalTabComponent<any> | null): void {
        const state = this.panel
        const terminalTab = _terminal ?? this.resolveTerminalForSend()
        if (!state?.visible || !terminalTab) {
            if (!terminalTab) {
                this.notifications.info(t(this.translate, this.locale, 'No active terminal'))
            }
            return
        }

        const model = state.editor.getModel()
        if (!model) {
            return
        }

        if (findRunnableCodeBlockAtLine(state.editor, lineNumber, this.getCodeBlockRunSettings())) {
            this.notifications.info(t(this.translate, this.locale, 'Send is disabled inside code blocks — use Loop or Run (F9)'))
            return
        }

        const text = stripComments(model.getLineContent(lineNumber))
        if (!text.trim()) {
            this.notifications.info(t(this.translate, this.locale, 'Nothing to send'))
            return
        }

        state.editor.setPosition({ lineNumber, column: 1 })
        state.editor.revealLineInCenterIfOutsideViewport(lineNumber)
        this.sendToTerminal(terminalTab, text)
    }

    private isRightClickSendLineEnabled (): boolean {
        return this.config.store.commandEditor?.rightClickSendLine === true
    }

    async loopOrRun (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.panel
        if (!state?.visible) {
            return
        }

        const editor = state.editor
        const findActive = this.isFindWidgetVisible()
        const selection = editor.getSelection()
        if (selection && !selection.isEmpty() && !findActive) {
            await this.sendLinesWithInterval(_terminal)
            return
        }

        const block = findRunnableCodeBlockAtCursor(editor, this.getCodeBlockRunSettings())
        if (block) {
            await this.runCurrentPythonCodeBlock()
            return
        }

        const terminalTab = _terminal ?? this.resolveTerminalForSend()
        if (!terminalTab) {
            this.notifications.info(t(this.translate, this.locale, 'No active terminal'))
            return
        }

        if (!terminalTab.session) {
            this.notifications.error(t(this.translate, this.locale, 'Terminal session not ready'))
            return
        }

        const position = editor.getPosition()
        const model = editor.getModel()
        if (!model) {
            return
        }

        const lineNumber = findActive && selection && !selection.isEmpty()
            ? selection.startLineNumber
            : position?.lineNumber
        if (!lineNumber) {
            return
        }

        const rawLine = model.getLineContent(lineNumber)
        const lineText = stripComments(rawLine).trim()

        if (lineText) {
            try {
                this.sendLineToTerminal(terminalTab, lineText)
            } catch (error) {
                console.error('[CommandEditorPanel] Line send failed:', error)
                this.notifications.error(t(this.translate, this.locale, 'Loop send failed'))
                return
            }
        }

        if (lineNumber < model.getLineCount()) {
            this.moveEditorToLine(editor, lineNumber + 1)
            if (findActive) {
                editor.focus()
            }
        }
    }

    async runCurrentPythonCodeBlock (): Promise<void> {
        const state = this.panel
        const terminal = this.resolveTerminalForSend()
        if (!state?.visible || !terminal) {
            if (!terminal) {
                this.notifications.info(t(this.translate, this.locale, 'No active terminal'))
            }
            return
        }

        const runSettings = this.getCodeBlockRunSettings()
        const block = findRunnableCodeBlockAtCursor(state.editor, runSettings)
        if (!block) {
            this.notifications.info(
                t(this.translate, this.locale, 'Place the cursor inside a runnable code block ({languages})', {
                    languages: this.getRunnableLanguageFamilies().join(', '),
                }),
            )
            return
        }
        if (!block.code.trim()) {
            this.notifications.info(t(this.translate, this.locale, 'Code block is empty'))
            return
        }

        if (block.language.toLowerCase() === 'tabby') {
            await this.runTabbyBlockInBackground(block.code, terminal, state)
        } else {
            await this.runScriptBlockInTerminal(block, terminal, state)
        }
    }

    private async runTabbyBlockInBackground (
        code: string,
        terminal: BaseTerminalTabComponent<any>,
        state: PanelState,
    ): Promise<void> {
        if (!terminal.session) {
            this.notifications.error(t(this.translate, this.locale, 'Terminal session not ready'))
            return
        }

        const jobId = ++this.nextTabbyRunJobId
        const terminalLabel = this.getTerminalLabel(terminal)
        const ui = this.createTabbyRunJobElement(state, jobId, terminalLabel)
        const execution = runCodeBlock(
            code,
            'tabby',
            line => {
                const job = this.tabbyRunJobs.get(jobId)
                if (!job) return
                const command = decodeTabbySendLine(line)
                if (command !== null) {
                    if (command.trim() && this.isTerminalTabAlive(terminal) && terminal.session) {
                        this.sendToTerminal(terminal, command)
                    }
                    return
                }
                this.appendTabbyRunOutput(job, line)
            },
            line => {
                const job = this.tabbyRunJobs.get(jobId)
                if (job) this.appendTabbyRunOutput(job, line)
            },
            undefined,
            undefined,
            {
                ...this.getCodeBlockRunSettings(),
                languageAliases: {
                    ...this.getCodeBlockRunSettings().languageAliases,
                    tabby: 'python',
                },
            },
        )
        const outputSubscription = terminal.output$.subscribe(data => execution.writeTerminalOutput(data))
        this.tabbyRunJobs.set(jobId, {
            id: jobId,
            terminal,
            terminalLabel,
            execution,
            outputSubscription,
            rootEl: ui.root,
            labelEl: ui.label,
            previewEl: ui.preview,
        })
        this.syncBatchStatusContainer(state)
        state.editor.layout()

        try {
            await execution.promise
            const job = this.tabbyRunJobs.get(jobId)
            if (job) job.labelEl.textContent = 'Tabby · completed'
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const job = this.tabbyRunJobs.get(jobId)
            if (job && message !== 'Script execution cancelled') {
                this.appendTabbyRunOutput(job, `Error: ${message}`)
                job.labelEl.textContent = 'Tabby · failed'
            }
        } finally {
            window.setTimeout(() => this.removeTabbyRunJob(jobId, false), 1200)
        }
    }

    private async runScriptBlockInTerminal (
        block: { code: string; language: string },
        terminal: BaseTerminalTabComponent<any>,
        state: PanelState,
    ): Promise<void> {
        if (!terminal.session) {
            this.notifications.error(t(this.translate, this.locale, 'Terminal session not ready'))
            return
        }

        const runSettings = this.getCodeBlockRunSettings()
        const scriptLanguage = resolveScriptLanguage(block.language, runSettings)
        if (!scriptLanguage) {
            this.notifications.info(t(this.translate, this.locale, 'Unsupported code block language: {language}', {
                language: block.language,
            }))
            return
        }

        const terminalLabel = this.getTerminalLabel(terminal)
        const payload = resolveScriptTerminalPayload(scriptLanguage, block.code, runSettings)
        const languageLabel = this.getScriptLanguageLabel(block.language)

        try {
            this.sendLineToTerminal(terminal, payload.command)
            this.notifications.notice(
                t(this.translate, this.locale, '{terminalLabel}: {languageLabel} script sent to terminal ({mode})', {
                    terminalLabel,
                    languageLabel,
                    mode: 'terminal file',
                }),
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to run script in terminal'
            console.error('[CommandEditor] Terminal script execution failed:', error)
            this.notifications.error(`${terminalLabel}: ${message}`)
        } finally {
            state.editor.focus()
        }
    }

    async sendLinesWithInterval (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.panel
        if (!state?.visible) {
            return
        }

        if (!state.batchStatusContainer || !state.sendIntervalInput || !state.sendLoopCountInput) {
            this.notifications.error(t(this.translate, this.locale, 'Loop send failed'))
            console.warn('[CommandEditorPanel] Panel UI outdated — close and reopen the panel (Ctrl+E)')
            return
        }

        const terminalTab = _terminal ?? this.getActiveTerminalTab()
        if (!terminalTab) {
            this.notifications.info(t(this.translate, this.locale, 'No active terminal'))
            return
        }

        if (!terminalTab.session) {
            this.notifications.error(t(this.translate, this.locale, 'Terminal session not ready'))
            console.warn('[CommandEditorPanel] Loop send blocked: terminal.session is null')
            return
        }

        const lines = this.getLoopSendLines(state.editor)
        if (lines.length === 0) {
            this.notifications.info(t(this.translate, this.locale, 'Nothing to send'))
            return
        }

        const intervalSec = this.readSendIntervalSec(state)
        const delayMs = Math.max(0, intervalSec * 1000)
        const loopCount = this.readSendLoopCount(state)

        console.error('[CommandEditorPanel] Loop send start', {
            build: PLUGIN_BUILD_ID,
            lineCount: lines.length,
            loopCount,
            intervalSec,
            delayMs,
            hasSession: !!terminalTab.session,
            terminalTitle: (terminalTab as { title?: string }).title ?? null,
            lines,
        })

        this.startLoopSendJob(state, terminalTab, lines, delayMs, loopCount)
    }

    cancelLoopSend (): void {
        if (this.loopSendJobs.size === 0 && this.tabbyRunJobs.size === 0) {
            return
        }

        this.cancelAllLoopJobs()
        this.cancelAllTabbyRuns()
    }

    private startLoopSendJob (
        state: PanelState,
        terminal: BaseTerminalTabComponent<any>,
        lines: string[],
        delayMs: number,
        loopCount: number,
    ): void {
        const jobId = ++this.nextLoopSendJobId
        const colorIndex = this.getTerminalColorIndex(terminal)
        const terminalLabel = this.getTerminalLabel(terminal)
        const jobUi = this.createLoopJobElement(state, jobId, terminalLabel, colorIndex)

        const job: LoopSendJob = {
            id: jobId,
            terminal,
            terminalLabel,
            lines,
            delayMs,
            loopCount,
            colorIndex,
            rootEl: jobUi.root,
            labelEl: jobUi.label,
            previewEl: jobUi.preview,
        }

        this.loopSendJobs.set(jobId, job)
        this.updateLoopJobStatus(job, 0, 0)
        this.syncBatchStatusContainer(state)
        state.editor.layout()

        let sentCount = 0

        const finish = (): void => {
            if (!this.loopSendJobs.has(jobId)) {
                return
            }

            this.cancelLoopJob(jobId)
            if (sentCount > 0) {
                this.notifications.notice(`${terminalLabel}: ${t(this.translate, this.locale, 'Lines sent')} (${sentCount})`)
            }
        }

        const scheduleAt = (round: number, lineIndex: number, delay: number): void => {
            this.zone.runOutsideAngular(() => {
                window.setTimeout(() => {
                    this.zone.run(() => sendAt(round, lineIndex))
                }, delay)
            })
        }

        const sendAt = (round: number, lineIndex: number): void => {
            if (!this.loopSendJobs.has(jobId)) {
                return
            }

            if (round >= loopCount) {
                finish()
                return
            }

            if (lineIndex >= lines.length) {
                scheduleAt(round + 1, 0, round + 1 >= loopCount ? 0 : delayMs)
                return
            }

            if (!this.isTerminalTabAlive(terminal) || !terminal.session) {
                this.cancelLoopJob(jobId)
                console.error('[CommandEditorPanel] Loop send stopped: terminal closed', terminalLabel)
                return
            }

            this.updateLoopJobStatus(job, lineIndex, round)

            try {
                this.sendLineToTerminal(terminal, lines[lineIndex])
                sentCount++
            } catch (err) {
                console.error('[CommandEditorPanel] Loop send failed:', err)
                this.cancelLoopJob(jobId)
                this.notifications.error(t(this.translate, this.locale, 'Loop send failed'))
                return
            }

            const nextLineIndex = lineIndex + 1
            const isLastLine = nextLineIndex >= lines.length
            const isLastRound = round + 1 >= loopCount
            const nextDelay = isLastLine && isLastRound ? 0 : delayMs

            if (isLastLine) {
                scheduleAt(round + 1, 0, nextDelay)
            } else {
                scheduleAt(round, nextLineIndex, nextDelay)
            }
        }

        this.zone.run(() => sendAt(0, 0))
    }

    private cancelLoopJob (jobId: number): void {
        const job = this.loopSendJobs.get(jobId)
        if (!job) {
            return
        }

        this.loopSendJobs.delete(jobId)
        job.rootEl.remove()
        if (this.panel) {
            this.syncBatchStatusContainer(this.panel)
            this.panel.editor.layout()
        }
    }

    private cancelAllLoopJobs (): void {
        for (const jobId of [...this.loopSendJobs.keys()]) {
            this.cancelLoopJob(jobId)
        }
    }

    private cancelAllTabbyRuns (): void {
        for (const jobId of [...this.tabbyRunJobs.keys()]) {
            this.removeTabbyRunJob(jobId, true)
        }
    }

    private getTerminalColorIndex (terminal: BaseTerminalTabComponent<any>): number {
        const existing = this.terminalLoopColors.get(terminal)
        if (existing !== undefined) {
            return existing
        }

        const colorIndex = this.nextLoopSendColorIndex % LOOP_JOB_COLORS.length
        this.nextLoopSendColorIndex++
        this.terminalLoopColors.set(terminal, colorIndex)
        return colorIndex
    }

    private pruneDeadLoopJobs (): void {
        for (const job of [...this.loopSendJobs.values()]) {
            if (!this.isTerminalTabAlive(job.terminal)) {
                this.cancelLoopJob(job.id)
            }
        }

        for (const terminal of [...this.terminalLoopColors.keys()]) {
            if (!this.isTerminalTabAlive(terminal)) {
                this.terminalLoopColors.delete(terminal)
            }
        }

        for (const job of [...this.tabbyRunJobs.values()]) {
            if (!this.isTerminalTabAlive(job.terminal)) {
                this.removeTabbyRunJob(job.id, true)
            }
        }

    }

    closeFile (): void {
        const state = this.panel
        if (!state) {
            return
        }

        this.clearSymbolLineHighlight(state.editor)
        state.editor.setValue('')
        state.filePath = null

        const model = state.editor.getModel()
        if (model) {
            monaco.editor.setModelLanguage(model, COMMAND_EDITOR_LANGUAGE)
        }

        if (this.config.store.commandEditor) {
            this.config.store.commandEditor.lastOpenedFile = null
            this.config.save()
        }

        this.updateFileLabel(state)
        state.editor.focus()
    }

    private ensurePanel (): PanelState {
        if (this.panel && !this.panel.batchStatusContainer) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel && !this.panel.sendLoopCountInput) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel && 'stepSendBtn' in this.panel) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel && 'autoSendBtn' in this.panel) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel && (!('sendIntervalUnitSelect' in (this.panel as object))
            || 'sendIntervalUnitRadios' in (this.panel as object))) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel && !('fileHistoryButton' in (this.panel as object))) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel && !('fileHistoryMenu' in (this.panel as object))) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel) {
            return this.panel
        }

        this.installStyles()
        this.registerEditorLanguageFeatures()

        const root = document.createElement('div')
        root.id = BAR_ID
        root.style.display = 'none'

        const resizeHandle = document.createElement('div')
        resizeHandle.className = 'command-editor-panel-resize-handle'
        resizeHandle.title = 'Drag to resize'
        resizeHandle.addEventListener('mousedown', (event: MouseEvent) => {
            event.preventDefault()
            if (!this.panel?.visible) {
                return
            }

            this.panelResizeDrag = {
                active: true,
                startPos: this.getPanelPosition() === 'right' ? event.clientX : event.clientY,
                startSize: this.panel.panelSizePx,
            }
            document.body.style.cursor = this.getPanelPosition() === 'right' ? 'col-resize' : 'row-resize'
            document.body.style.userSelect = 'none'
        })

        const toolbar = document.createElement('div')
        toolbar.className = 'command-editor-panel-toolbar'

        const mkBtn = (label: string, primary = false) => {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.textContent = label
            btn.className = primary ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'
            return btn
        }

        const openBtn = mkBtn('Open')
        const saveBtn = mkBtn('Save')
        const closeBtn = mkBtn('Close')
        const filePicker = document.createElement('div')
        filePicker.className = 'command-editor-panel-file-picker'

        const fileHistoryButton = document.createElement('button')
        fileHistoryButton.type = 'button'
        fileHistoryButton.className = 'btn btn-sm btn-outline-secondary command-editor-panel-file-history-button'
        fileHistoryButton.title = 'Opened file history'

        const fileHistoryMenu = document.createElement('div')
        fileHistoryMenu.className = 'command-editor-panel-file-history-menu'

        filePicker.append(fileHistoryButton, fileHistoryMenu)

        const sendGroup = document.createElement('div')
        sendGroup.className = 'command-editor-panel-send-group'

        const intervalWrap = document.createElement('label')
        intervalWrap.className = 'command-editor-panel-interval'
        intervalWrap.title = 'Scroll to adjust; step: min ±1, s ±0.1, ms ±10'

        const intervalUnit = this.getSendLineIntervalUnit()
        const sendIntervalInput = document.createElement('input')
        sendIntervalInput.type = 'number'
        sendIntervalInput.className = 'command-editor-panel-interval-input form-control form-control-sm'
        sendIntervalInput.min = '0'
        this.applyIntervalInputStep(sendIntervalInput, intervalUnit)
        sendIntervalInput.value = this.formatIntervalDisplayValue(
            this.secToIntervalDisplay(this.getSendLineIntervalSec(), intervalUnit),
            intervalUnit,
        )

        const sendIntervalUnitSelect = document.createElement('select')
        sendIntervalUnitSelect.className = 'command-editor-panel-interval-unit-select form-select form-select-sm'
        sendIntervalUnitSelect.title = 'Interval unit'
        for (const unit of SEND_LINE_INTERVAL_UNITS) {
            const option = document.createElement('option')
            option.value = unit
            option.textContent = unit
            sendIntervalUnitSelect.append(option)
        }
        sendIntervalUnitSelect.value = intervalUnit
        sendIntervalUnitSelect.addEventListener('change', () => {
            const unit = sendIntervalUnitSelect.value as SendLineIntervalUnit
            if (SEND_LINE_INTERVAL_UNITS.includes(unit)) {
                this.setSendIntervalUnit(unit)
            }
        })

        intervalWrap.append(sendIntervalInput, sendIntervalUnitSelect)

        const loopCountWrap = document.createElement('label')
        loopCountWrap.className = 'command-editor-panel-interval'
        loopCountWrap.title = 'Repeat count (run selected lines this many times)'

        const sendLoopCountInput = document.createElement('input')
        sendLoopCountInput.type = 'number'
        sendLoopCountInput.className = 'command-editor-panel-loop-count-input form-control form-control-sm'
        sendLoopCountInput.min = '1'
        sendLoopCountInput.step = '1'
        sendLoopCountInput.value = String(this.getSendLoopCount())

        const loopCountUnit = document.createElement('span')
        loopCountUnit.className = 'command-editor-panel-interval-unit'
        loopCountUnit.textContent = '×'

        loopCountWrap.append(sendLoopCountInput, loopCountUnit)

        const loopSendBtn = mkBtn('Loop or Run')
        loopSendBtn.title = 'F9 — Loop or Run; F6 stops loops; code blocks run as terminal files; selection: loop'

        const sendBtn = mkBtn('Send', true)
        sendBtn.title = 'Enter/F8 — comments stripped; line or selection; send immediately; code block: disabled (use Loop or Run / F9)'

        sendGroup.append(intervalWrap, loopCountWrap, loopSendBtn, sendBtn)
        toolbar.append(openBtn, saveBtn, closeBtn, filePicker, sendGroup)

        const batchStatusContainer = document.createElement('div')
        batchStatusContainer.className = 'command-editor-panel-batch-status-container'

        const editorHost = document.createElement('div')
        editorHost.className = 'command-editor-panel-editor-host'

        root.append(resizeHandle, toolbar, batchStatusContainer, editorHost)

        const editor = monaco.editor.create(editorHost, {
            value: '',
            language: COMMAND_EDITOR_LANGUAGE,
            theme: this.getEditorTheme(),
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: false,
            wordWrap: 'on',
            lineNumbers: 'on',
            folding: true,
            foldingStrategy: 'auto',
            showFoldingControls: 'mouseover',
            fontSize: 14,
            fontFamily: 'monospace',
            tabSize: 2,
            insertSpaces: true,
            quickSuggestions: false,
            inlineSuggest: { enabled: true },
            scrollbar: {
                vertical: 'auto',
                horizontal: 'hidden',
                useShadows: false,
            },
            overviewRulerLanes: 0,
            contextmenu: !this.isRightClickSendLineEnabled(),
        })

        openBtn.addEventListener('click', () => this.openFile())
        saveBtn.addEventListener('click', () => this.saveFile())
        closeBtn.addEventListener('click', () => this.closeFile())
        fileHistoryButton.addEventListener('click', () => this.toggleFileHistoryMenu())
        sendBtn.addEventListener('click', () => this.sendFromPanel())
        loopSendBtn.addEventListener('mousedown', (event: MouseEvent) => {
            event.preventDefault()
            this.savedEditorSelection = editor.getSelection()
        })
        loopSendBtn.addEventListener('click', () => void this.loopOrRun())
        sendIntervalInput.addEventListener('change', () => {
            if (this.panel) {
                this.persistSendIntervalInput(this.panel)
            }
        })
        sendIntervalInput.addEventListener('wheel', (event: WheelEvent) => {
            event.preventDefault()
            if (this.panel) {
                this.adjustIntervalInput(this.panel, event.deltaY < 0)
            }
        }, { passive: false })
        sendLoopCountInput.addEventListener('change', () => this.persistSendLoopCountInput(sendLoopCountInput))

        this.setupEditorKeybindings(editor)
        this.setupCommandHistoryCompletion(editor)
        this.setupRightClickSendLine(editor, editorHost)

        editor.onDidChangeCursorSelection((event) => {
            this.savedEditorSelection = event.selection
            this.handleSelectionHighlight(editor, event)
        })
        editor.onDidFocusEditorWidget(() => {
            this.editorFocused = true
        })
        editor.onDidBlurEditorWidget(() => {
            this.editorFocused = false
        })

        this.panel = {
            root,
            resizeHandle,
            editorHost,
            editor,
            fileHistoryButton,
            fileHistoryMenu,
            sendIntervalInput,
            sendIntervalUnitSelect,
            sendLoopCountInput,
            loopSendBtn,
            batchStatusContainer,
            filePath: null,
            visible: false,
            panelSizePx: 0,
        }
        this.refreshFileHistoryDropdown(this.panel)
        this.applyPendingLastOpenedFile(this.panel)
        return this.panel
    }

    private applyPendingLastOpenedFile (state: PanelState): void {
        if (!this.pendingLastOpenedFile) {
            return
        }

        const filePath = this.pendingLastOpenedFile
        this.pendingLastOpenedFile = null

        if (this.loadFileFromPath(state, filePath)) {
            this.addFileToHistory(filePath)
        } else if (this.config.store.commandEditor) {
            this.config.store.commandEditor.lastOpenedFile = null
            this.config.save()
        }
    }

    private persistLastOpenedFile (filePath: string): void {
        if (!this.config.store.commandEditor) {
            return
        }
        this.config.store.commandEditor.lastOpenedFile = filePath
        this.addFileToHistory(filePath)
    }

    private getOpenedFileHistory (): string[] {
        const history = this.config.store.commandEditor?.openedFileHistory
        if (!Array.isArray(history)) {
            return []
        }

        return history.filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
    }

    private setOpenedFileHistory (history: string[]): void {
        if (!this.config.store.commandEditor) {
            return
        }

        this.config.store.commandEditor.openedFileHistory = [...new Set(history)].slice(0, 50)
        this.config.save()
        if (this.panel) {
            this.refreshFileHistoryDropdown(this.panel)
        }
    }

    private addFileToHistory (filePath: string): void {
        const nextHistory = [filePath, ...this.getOpenedFileHistory().filter(path => path !== filePath)]
        this.setOpenedFileHistory(nextHistory)
    }

    private removeFileFromHistory (filePath: string): void {
        const nextHistory = this.getOpenedFileHistory().filter(path => path !== filePath)
        if (this.config.store.commandEditor?.lastOpenedFile === filePath) {
            this.config.store.commandEditor.lastOpenedFile = this.panel?.filePath === filePath ? null : this.panel?.filePath ?? null
        }
        this.setOpenedFileHistory(nextHistory)
    }

    private openHistoryFile (state: PanelState, filePath: string): void {
        if (!this.loadFileFromPath(state, filePath)) {
            this.notifications.error(t(this.translate, this.locale, 'File not found'))
            this.removeFileFromHistory(filePath)
            this.closeFileHistoryMenu(state)
            return
        }

        this.persistLastOpenedFile(filePath)
        this.closeFileHistoryMenu(state)
        state.editor.layout()
        state.editor.focus()
    }

    private toggleFileHistoryMenu (): void {
        const state = this.panel
        if (!state || state.fileHistoryButton.disabled) {
            return
        }

        state.fileHistoryMenu.classList.toggle('open')
    }

    private closeFileHistoryMenu (state: PanelState): void {
        state.fileHistoryMenu.classList.remove('open')
    }

    private refreshFileHistoryDropdown (state: PanelState): void {
        const button = state.fileHistoryButton
        const menu = state.fileHistoryMenu
        const currentValue = state.filePath ?? ''
        const history = this.getOpenedFileHistory()

        menu.textContent = ''

        if (history.length === 0) {
            button.textContent = 'No file history'
            button.disabled = true
            this.closeFileHistoryMenu(state)
            return
        }

        const selectedPath = history.includes(currentValue) ? currentValue : ''
        button.textContent = selectedPath ? this.formatHistoryFileLabel(selectedPath) : 'Select file history...'
        button.title = selectedPath || 'Opened file history'
        button.disabled = false

        for (const filePath of history) {
            const item = document.createElement('div')
            item.className = 'command-editor-panel-file-history-item'
            if (filePath === selectedPath) {
                item.classList.add('active')
            }

            const openBtn = document.createElement('button')
            openBtn.type = 'button'
            openBtn.className = 'command-editor-panel-file-history-open'
            openBtn.title = filePath
            openBtn.textContent = this.formatHistoryFileLabel(filePath)
            openBtn.addEventListener('click', () => this.openHistoryFile(state, filePath))

            const removeBtn = document.createElement('button')
            removeBtn.type = 'button'
            removeBtn.className = 'command-editor-panel-file-history-remove'
            removeBtn.title = 'Remove from history'
            removeBtn.textContent = '×'
            removeBtn.addEventListener('click', (event: MouseEvent) => {
                event.preventDefault()
                event.stopPropagation()
                this.removeFileFromHistory(filePath)
                state.editor.focus()
            })

            item.append(openBtn, removeBtn)
            menu.append(item)
        }

    }

    private formatHistoryFileLabel (filePath: string): string {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path') as typeof import('path')
        const base = path.basename(filePath)
        const dir = path.dirname(filePath)
        return dir && dir !== '.' ? `${base} — ${dir}` : base
    }

    private loadFileFromPath (state: PanelState, filePath: string): boolean {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs')
        if (!fs.existsSync(filePath)) {
            return false
        }

        let content = fs.readFileSync(filePath, 'utf8')
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1)
        }

        const model = state.editor.getModel()
        if (model) {
            monaco.editor.setModelLanguage(model, COMMAND_EDITOR_LANGUAGE)
        }
        state.editor.setValue(content)
        state.filePath = filePath
        this.updateFileLabel(state)
        this.refreshFileHistoryDropdown(state)
        return true
    }

    private updateFileLabel (state: PanelState): void {
        if (!state.filePath) {
            this.refreshFileHistoryDropdown(state)
            return
        }

        this.refreshFileHistoryDropdown(state)
    }

    private getTabContentArea (): HTMLElement | null {
        return document.querySelector(TAB_CONTENT_SELECTOR) as HTMLElement | null
    }

    /** Mount inside the terminal tab area so the panel sits beside terminals, not over the title/tab bar */
    private mountPanel (root: HTMLElement): void {
        const tabArea = this.getTabContentArea()
        ;(tabArea ?? document.body).appendChild(root)
    }

    private getPanelPosition (): PanelPosition {
        return this.config.store.commandEditor?.panelPosition === 'right' ? 'right' : 'bottom'
    }

    private applyPanelPosition (state: PanelState): void {
        const position = this.getPanelPosition()
        state.root.classList.remove('position-bottom', 'position-right')
        state.root.classList.add(position === 'right' ? 'position-right' : 'position-bottom')

        const broadcastOffset = this.getBroadcastBarHeight()
        state.root.style.bottom = broadcastOffset > 0 ? `${broadcastOffset}px` : '0'
    }

    private getDefaultPanelSize (host: HTMLElement, position: PanelPosition): number {
        const saved = this.config.store.commandEditor?.panelSize
        if (typeof saved === 'number' && saved > 0) {
            return this.clampPanelSize(saved, host, position)
        }

        return this.clampPanelSize(
            Math.round((position === 'right' ? host.clientWidth : host.clientHeight) * 0.38),
            host,
            position,
        )
    }

    private clampPanelSize (size: number, host: HTMLElement, position: PanelPosition): number {
        if (position === 'right') {
            const min = 280
            const max = Math.max(min, Math.round(host.clientWidth * 0.75))
            return Math.max(min, Math.min(max, size))
        }

        const min = 120
        const max = Math.max(min, Math.round(host.clientHeight * 0.75))
        return Math.max(min, Math.min(max, size))
    }

    private setPanelSize (state: PanelState, sizePx: number): void {
        state.panelSizePx = sizePx
        const position = this.getPanelPosition()
        if (position === 'right') {
            state.root.style.width = `${sizePx}px`
        } else {
            state.root.style.height = `${sizePx}px`
        }
    }

    private applyPanelDimensions (state: PanelState): void {
        const host = this.getTabContentArea()
        if (!host) {
            return
        }

        const position = this.getPanelPosition()
        if (state.panelSizePx <= 0) {
            this.setPanelSize(state, this.getDefaultPanelSize(host, position))
        } else {
            this.setPanelSize(state, this.clampPanelSize(state.panelSizePx, host, position))
        }
    }

    private persistPanelSize (): void {
        if (!this.panel?.visible || !this.config.store.commandEditor) {
            return
        }

        this.config.store.commandEditor.panelSize = this.panel.panelSizePx
        this.config.save()
    }

    /** Keep terminal area and editor split in sync */
    private syncPanelLayout (state: PanelState): void {
        this.applyPanelPosition(state)
        this.applyPanelDimensions(state)
        this.applySplitLayout(state)
        this.startTabAreaObserver()
        state.editor.layout()
        this.fitAllTerminals()
        this.notifyTerminalLayoutChanged()
    }

    private showPanel (
        state: PanelState,
        terminalHint?: BaseTerminalTabComponent<any> | null,
    ): void {
        this.targetTerminalTab = terminalHint ?? this.getActiveTerminalTab()
        this.mountPanel(state.root)
        window.addEventListener('mousemove', this.onPanelResizeMove)
        window.addEventListener('mouseup', this.onPanelResizeEnd)
        state.root.style.display = 'flex'
        state.visible = true
        document.body.classList.add(BODY_CLASS)
        document.body.dataset.commandEditorPanelPosition = this.getPanelPosition()
        window.addEventListener('resize', this.onWindowResize)
        this.startTabAreaObserver()
        this.startActiveTabWatcher()

        requestAnimationFrame(() => {
            state.editor.updateOptions({ automaticLayout: true })
            this.syncPanelLayout(state)
            state.editor.focus()
        })
    }

    private hidePanel (state: PanelState): void {
        closeHeadingOutlinePicker()
        this.clearSymbolLineHighlight(state.editor)
        this.cancelAllLoopJobs()
        this.cancelAllTabbyRuns()
        this.onPanelResizeEnd()
        window.removeEventListener('mousemove', this.onPanelResizeMove)
        window.removeEventListener('mouseup', this.onPanelResizeEnd)
        state.root.style.display = 'none'
        state.visible = false
        state.root.remove()
        state.editor.updateOptions({ automaticLayout: false })
        this.editorFocused = false
        document.body.classList.remove(BODY_CLASS)
        delete document.body.dataset.commandEditorPanelPosition
        window.removeEventListener('resize', this.onWindowResize)
        this.stopTabAreaObserver()
        this.stopActiveTabWatcher()
        this.targetTerminalTab = null
        this.restoreLayout(state)
        this.notifyTerminalLayoutChanged()
    }

    /** Shrink the active terminal tab pane (not padding — xterm uses absolute .content-tab) */
    private applySplitLayout (state: PanelState): void {
        document.documentElement.style.setProperty(PANEL_SIZE_VAR, `${state.panelSizePx}px`)
        this.layoutAdjusted = true
    }

    private startTabAreaObserver (): void {
        if (typeof ResizeObserver === 'undefined') {
            return
        }

        this.stopTabAreaObserver()
        const target = document.querySelector(CONTENT_TAB_SELECTOR) as HTMLElement | null
            ?? this.getTabContentArea()
        if (!target) {
            return
        }

        this.tabAreaObserver = new ResizeObserver(() => {
            if (!this.panel?.visible) {
                return
            }
            this.fitAllTerminals()
            this.panel.editor.layout()
        })
        this.tabAreaObserver.observe(target)
    }

    private stopTabAreaObserver (): void {
        this.tabAreaObserver?.disconnect()
        this.tabAreaObserver = null
    }

    private startActiveTabWatcher (): void {
        this.stopActiveTabWatcher()
        this.activeTabSubscription = this.app.activeTabChange$.subscribe(() => {
            if (!this.panel?.visible) {
                return
            }

            const activeTerminal = this.getActiveTerminalTab()
            if (activeTerminal) {
                this.targetTerminalTab = activeTerminal
            } else if (this.targetTerminalTab && !this.isTerminalTabAlive(this.targetTerminalTab)) {
                this.targetTerminalTab = null
            }

            this.pruneDeadLoopJobs()

            this.startTabAreaObserver()
            this.fitAllTerminals()
        })
    }

    private stopActiveTabWatcher (): void {
        this.activeTabSubscription?.unsubscribe()
        this.activeTabSubscription = null
    }

    private fitAllTerminals (): void {
        const run = (): void => {
            for (const tab of this.app.tabs) {
                this.fitTerminalInTab(tab)
            }
        }

        run()
        requestAnimationFrame(() => {
            run()
            requestAnimationFrame(run)
        })
    }

    private fitTerminalInTab (tab: unknown): void {
        if (tab instanceof BaseTerminalTabComponent) {
            this.fitTerminalFrontend(tab)
            return
        }

        if (tab instanceof SplitTabComponent) {
            for (const child of tab.getAllTabs()) {
                this.fitTerminalInTab(child)
            }
        }
    }

    private fitTerminalFrontend (tab: BaseTerminalTabComponent<any>): void {
        const frontend = tab.frontend as {
            resizeHandler?: () => void
            fitAddon?: { fit?: () => void }
        } | undefined
        if (!frontend) {
            return
        }

        try {
            if (typeof frontend.resizeHandler === 'function') {
                frontend.resizeHandler()
            } else if (typeof frontend.fitAddon?.fit === 'function') {
                frontend.fitAddon.fit()
            }
        } catch {
            // Ignore fit errors on detached tabs
        }
    }

    private runFindWidgetMatch (forward: boolean): void {
        const editor = this.panel?.editor
        if (!editor) {
            return
        }

        void editor.trigger(
            'keyboard',
            forward ? 'editor.action.nextMatchFindAction' : 'editor.action.previousMatchFindAction',
            null,
        )
    }

    private setupEditorKeybindings (
        editor: monaco.editor.IStandaloneCodeEditor,
    ): void {
        const send = () => this.sendFromPanel()
        const insertNewline = () => {
            const selection = editor.getSelection()
            if (!selection) {
                return
            }
            editor.executeEdits('insert-newline', [{
                range: selection,
                text: '\n',
                forceMoveMarkers: true,
            }])
        }
        /** Insert a newline without sending; inside `<!-- -->` splits into a block comment. */
        const insertEditorNewline = () => {
            if (!splitMarkdownCommentNewline(editor)) {
                insertNewline()
            }
        }
        // Opening the find widget must not change Enter while focus remains in the editor.
        // Monaco's find input handles Enter/Shift+Enter itself when that input has focus.
        const editorContext = 'editorTextFocus && !suggestWidgetVisible'

        editor.addCommand(
            monaco.KeyCode.Tab,
            () => {
                if (!this.acceptCommandHistoryCompletion(editor)) {
                    editor.trigger('keyboard', 'tab', null)
                }
            },
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.Shift | monaco.KeyCode.Tab,
            () => {
                if (!this.selectNextCommandHistoryCompletion(editor)) {
                    editor.trigger('keyboard', 'outdent', null)
                }
            },
            editorContext,
        )

        editor.addCommand(monaco.KeyCode.Enter, send, editorContext)
        editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
            () => editor.trigger('keyboard', 'editor.action.insertLineAfter', null),
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
            () => editor.trigger('keyboard', 'editor.action.insertLineBefore', null),
            editorContext,
        )
        editor.addCommand(monaco.KeyCode.F6, () => this.cancelLoopSend(), editorContext)
        editor.addCommand(monaco.KeyCode.F8, send, editorContext)
        editor.addCommand(monaco.KeyCode.F9, () => void this.loopOrRun(), editorContext)
        const findContext = 'findWidgetVisible'
        editor.addCommand(
            monaco.KeyCode.F7,
            () => this.runFindWidgetMatch(true),
            findContext,
        )
        editor.addCommand(
            monaco.KeyMod.Shift | monaco.KeyCode.F7,
            () => this.runFindWidgetMatch(false),
            findContext,
        )
        editor.addCommand(
            monaco.KeyMod.Shift | monaco.KeyCode.Enter,
            () => this.saveFile(),
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash,
            () => editor.trigger('keyboard', 'editor.action.commentLine', null),
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Slash,
            () => toggleSmartComment(editor, this.getCodeBlockRunSettings()),
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.Alt | monaco.KeyCode.KeyA,
            () => toggleCodeFence(editor),
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backslash,
            () => editor.trigger('keyboard', 'editor.toggleFold', null),
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.Alt | monaco.KeyCode.Enter,
            insertEditorNewline,
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyA,
            () => editor.trigger('keyboard', 'editor.action.blockComment', null),
            editorContext,
        )

        // Suppress the command palette (F1 / Ctrl+Shift+P) so only Go to Line and
        // Go to Symbol remain reachable.
        const noop = () => { /* command palette disabled */ }
        editor.addCommand(monaco.KeyCode.F1, noop)
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, noop)
    }

    private setupCommandHistoryCompletion (
        editor: monaco.editor.IStandaloneCodeEditor,
    ): void {
        this.commandHistoryCompletionProvider?.dispose()
        this.commandHistoryCompletionProvider = monaco.languages.registerInlineCompletionsProvider(
            COMMAND_EDITOR_LANGUAGE,
            {
                provideInlineCompletions: (model, position) => {
                    if (model !== editor.getModel() || !this.hasSingleEmptySelection(editor)) {
                        return { items: [] }
                    }
                    const suggestion = findCommandHistorySuggestions(model, position)
                    if (!suggestion) {
                        this.resetCommandHistoryCompletion()
                        return { items: [] }
                    }
                    const index = this.getCommandHistoryCompletionIndex(suggestion.signature, suggestion.candidates.length)
                    return {
                        items: [{
                            insertText: suggestion.candidates[index],
                            range: suggestion.range,
                        }],
                    }
                },
                freeInlineCompletions: () => { /* no resources to release */ },
            },
        )
    }

    private acceptCommandHistoryCompletion (editor: monaco.editor.IStandaloneCodeEditor): boolean {
        const suggestion = this.getCommandHistorySuggestion(editor)
        if (!suggestion) {
            return false
        }
        const index = this.getCommandHistoryCompletionIndex(suggestion.signature, suggestion.candidates.length)
        editor.executeEdits('command-history-completion', [{
            range: suggestion.range,
            text: suggestion.candidates[index],
            forceMoveMarkers: true,
        }])
        this.resetCommandHistoryCompletion()
        return true
    }

    private selectNextCommandHistoryCompletion (editor: monaco.editor.IStandaloneCodeEditor): boolean {
        const suggestion = this.getCommandHistorySuggestion(editor)
        if (!suggestion) {
            return false
        }
        const index = this.getCommandHistoryCompletionIndex(suggestion.signature, suggestion.candidates.length)
        this.commandHistoryCompletionIndex = (index + 1) % suggestion.candidates.length
        editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', null)
        return true
    }

    private getCommandHistorySuggestion (editor: monaco.editor.IStandaloneCodeEditor) {
        const model = editor.getModel()
        const position = editor.getPosition()
        if (!model || !position || !this.hasSingleEmptySelection(editor)) {
            this.resetCommandHistoryCompletion()
            return null
        }
        return findCommandHistorySuggestions(model, position)
    }

    private hasSingleEmptySelection (editor: monaco.editor.IStandaloneCodeEditor): boolean {
        const selections = editor.getSelections()
        return selections?.length === 1 && selections[0].isEmpty()
    }

    private getCommandHistoryCompletionIndex (signature: string, candidateCount: number): number {
        if (this.commandHistoryCompletionSignature !== signature) {
            this.commandHistoryCompletionSignature = signature
            this.commandHistoryCompletionIndex = 0
        }
        this.commandHistoryCompletionIndex %= candidateCount
        return this.commandHistoryCompletionIndex
    }

    private resetCommandHistoryCompletion (): void {
        this.commandHistoryCompletionSignature = null
        this.commandHistoryCompletionIndex = 0
    }

    /**
     * Highlight the line jumped to from Go to Line (Ctrl+G) or Go to Symbol
     * (Ctrl+Shift+O / Shift+Alt+Enter). Both navigate via setSelection(source 'api'),
     * which lets us flash the target line without reacting to typing/clicking.
     */
    private handleSelectionHighlight (
        editor: monaco.editor.IStandaloneCodeEditor,
        event: monaco.editor.ICursorSelectionChangedEvent,
    ): void {
        const model = editor.getModel()
        if (!model) {
            return
        }

        const selection = event.selection
        const isSingleLine = selection.startLineNumber === selection.endLineNumber
        const isNavigation = event.source === 'api'
            && event.reason !== monaco.editor.CursorChangeReason.ContentFlush
            && isSingleLine
            && !this.isFindWidgetVisible()

        if (isNavigation) {
            this.applySymbolLineHighlight(editor, selection.startLineNumber)
        } else {
            this.clearSymbolLineHighlight(editor)
        }
    }

    private isFindWidgetVisible (): boolean {
        return !!this.panel?.editorHost.querySelector('.find-widget.visible')
    }

    private applySymbolLineHighlight (editor: monaco.editor.IStandaloneCodeEditor, line: number): void {
        // Clear first so the flash animation replays on a freshly created overlay element.
        this.clearSymbolLineHighlight(editor)
        this.symbolHighlightIds = editor.deltaDecorations([], [{
            range: new monaco.Range(line, 1, line, 1),
            options: {
                isWholeLine: true,
                className: 'command-editor-symbol-highlight',
                overviewRuler: {
                    color: 'rgba(77, 163, 255, 0.7)',
                    position: monaco.editor.OverviewRulerLane.Full,
                },
            },
        }])
    }

    private clearSymbolLineHighlight (editor: monaco.editor.IStandaloneCodeEditor): void {
        if (this.symbolHighlightIds.length > 0) {
            this.symbolHighlightIds = editor.deltaDecorations(this.symbolHighlightIds, [])
        }
    }

    private registerEditorLanguageFeatures (): void {
        if (CommandEditorPanelService.languageFeaturesRegistered) {
            return
        }
        CommandEditorPanelService.languageFeaturesRegistered = true

        registerCommandEditorLanguage()
        registerMarkdownHeadingFeatures()
        pruneQuickAccessProviders()
    }

    /** Find/replace box and other Monaco overlay inputs (not the main editor textarea). */
    private isMonacoOverlayInput (target: Node): boolean {
        if (!(target instanceof Element)) {
            return false
        }

        if (target.closest('.find-widget')) {
            return true
        }

        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            return !target.classList.contains('inputarea')
                && !!target.closest('.monaco-editor')
        }

        return false
    }

    private copyFromEditor (editor: monaco.editor.IStandaloneCodeEditor): void {
        const selection = editor.getSelection()
        const model = editor.getModel()
        if (!selection || !model) {
            return
        }

        const text = selection.isEmpty()
            ? `${model.getLineContent(selection.positionLineNumber)}\n`
            : model.getValueInRange(selection)
        if (text) {
            this.platform.setClipboard({ text })
            this.copiedWholeLineText = selection.isEmpty() ? text : null
        }
    }

    private pasteIntoEditor (editor: monaco.editor.IStandaloneCodeEditor): void {
        const text = this.platform.readClipboard()
        const selection = editor.getSelection()
        if (!text || !selection) {
            return
        }

        const pasteAsWholeLine = selection.isEmpty() && this.copiedWholeLineText === text
        const range = pasteAsWholeLine
            ? new monaco.Range(selection.positionLineNumber, 1, selection.positionLineNumber, 1)
            : selection
        editor.executeEdits('paste', [{ range, text, forceMoveMarkers: true }])
    }

    private cutFromEditor (editor: monaco.editor.IStandaloneCodeEditor): void {
        const selection = editor.getSelection()
        const model = editor.getModel()
        if (!selection || !model) {
            return
        }

        if (selection.isEmpty()) {
            const lineNumber = selection.positionLineNumber
            const text = `${model.getLineContent(lineNumber)}\n`
            this.platform.setClipboard({ text })
            this.copiedWholeLineText = text

            let range: monaco.Range
            if (model.getLineCount() === 1) {
                range = new monaco.Range(1, 1, 1, model.getLineMaxColumn(1))
            } else if (lineNumber < model.getLineCount()) {
                range = new monaco.Range(lineNumber, 1, lineNumber + 1, 1)
            } else {
                const previousLine = lineNumber - 1
                range = new monaco.Range(
                    previousLine,
                    model.getLineMaxColumn(previousLine),
                    lineNumber,
                    model.getLineMaxColumn(lineNumber),
                )
            }
            editor.executeEdits('cut-line', [{ range, text: '', forceMoveMarkers: true }])
            return
        }

        const text = model.getValueInRange(selection)
        if (!text) {
            return
        }

        this.platform.setClipboard({ text })
        this.copiedWholeLineText = null
        editor.executeEdits('cut', [{ range: selection, text: '', forceMoveMarkers: true }])
    }

    private handleInputClipboardShortcut (
        input: HTMLInputElement | HTMLTextAreaElement,
        key: string,
    ): void {
        const start = input.selectionStart ?? 0
        const end = input.selectionEnd ?? start
        switch (key) {
            case 'a':
                input.select()
                return
            case 'c':
                if (start !== end) {
                    this.platform.setClipboard({ text: input.value.slice(start, end) })
                    this.copiedWholeLineText = null
                }
                return
            case 'x':
                if (start !== end) {
                    this.platform.setClipboard({ text: input.value.slice(start, end) })
                    this.copiedWholeLineText = null
                    input.setRangeText('', start, end, 'end')
                    input.dispatchEvent(new Event('input', { bubbles: true }))
                }
                return
            case 'v': {
                const text = this.platform.readClipboard()
                if (text) {
                    input.setRangeText(text, start, end, 'end')
                    input.dispatchEvent(new Event('input', { bubbles: true }))
                }
            }
        }
    }

    /** Tell xterm/Tabby to reflow without re-entering our resize handler */
    private notifyTerminalLayoutChanged (): void {
        this.suppressResizeHandler = true
        try {
            window.dispatchEvent(new Event('resize'))
            this.fitAllTerminals()
        } finally {
            this.suppressResizeHandler = false
        }
    }

    private restoreLayout (_state: PanelState): void {
        if (!this.layoutAdjusted) {
            return
        }

        document.documentElement.style.setProperty(PANEL_SIZE_VAR, '0px')
        this.layoutAdjusted = false
        this.fitAllTerminals()
    }

    private getBroadcastBarHeight (): number {
        return document.getElementById(BROADCAST_BAR_ID)?.offsetHeight ?? 0
    }

    private installStyles (): void {
        document.getElementById(STYLE_ID)?.remove()

        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = `
            :root {
                ${PANEL_SIZE_VAR}: 0px;
            }

            body.${BODY_CLASS} ${TAB_CONTENT_SELECTOR} {
                position: relative;
            }

            body.${BODY_CLASS}[data-command-editor-panel-position="right"] app-root .content > .content > .content-tab.content-tab-active,
            body.${BODY_CLASS}[data-command-editor-panel-position="right"] app-root > .content > .content > .content-tab.content-tab-active {
                width: calc(100% - var(${PANEL_SIZE_VAR})) !important;
            }

            body.${BODY_CLASS}[data-command-editor-panel-position="bottom"] app-root .content > .content > .content-tab.content-tab-active,
            body.${BODY_CLASS}[data-command-editor-panel-position="bottom"] app-root > .content > .content > .content-tab.content-tab-active {
                height: calc(100% - var(${PANEL_SIZE_VAR})) !important;
            }

            body.${BODY_CLASS}[data-command-editor-panel-position="right"] search-panel {
                right: calc(50px + var(${PANEL_SIZE_VAR})) !important;
            }

            #${BAR_ID} {
                position: absolute;
                z-index: 100;
                display: flex;
                flex-direction: column;
                container-name: command-editor-panel;
                container-type: inline-size;
                overflow: hidden;
                background: var(--bs-body-bg, rgba(16, 18, 22, 0.96));
                backdrop-filter: blur(6px);
                box-shadow: 0 0 12px rgba(0, 0, 0, 0.35);
            }

            #${BAR_ID}.position-bottom {
                left: 0;
                right: 0;
                bottom: 0;
                width: 100%;
                border-top: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
            }

            #${BAR_ID}.position-right {
                top: 0;
                right: 0;
                height: 100%;
                border-left: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
            }

            #${BAR_ID} .command-editor-panel-resize-handle {
                position: absolute;
                z-index: 101;
                background: transparent;
                transition: background 0.15s ease;
            }

            #${BAR_ID} .command-editor-panel-resize-handle:hover,
            #${BAR_ID} .command-editor-panel-resize-handle:active {
                background: var(--bs-primary, rgba(47, 140, 255, 0.45));
            }

            #${BAR_ID}.position-right .command-editor-panel-resize-handle {
                left: 0;
                top: 0;
                bottom: 0;
                width: 5px;
                cursor: col-resize;
                transform: translateX(-50%);
            }

            #${BAR_ID}.position-bottom .command-editor-panel-resize-handle {
                left: 0;
                right: 0;
                top: 0;
                height: 5px;
                cursor: row-resize;
                transform: translateY(-50%);
            }

            #${BAR_ID} .command-editor-panel-toolbar {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                padding: 6px 8px;
                align-items: center;
                flex: none;
                border-bottom: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
            }

            #${BAR_ID} .command-editor-panel-send-group {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 4px;
                margin-left: auto;
                flex: none;
            }


            #${BAR_ID} .command-editor-panel-toolbar > .btn,
            #${BAR_ID} .command-editor-panel-send-group > .btn {
                flex: none;
                white-space: nowrap;
            }

            #${BAR_ID} .command-editor-panel-file-picker {
                display: flex;
                align-items: center;
                gap: 4px;
                flex: 1;
                min-width: 120px;
                position: relative;
            }

            @container command-editor-panel (max-width: 720px) {
                #${BAR_ID} .command-editor-panel-file-picker {
                    order: 10;
                    flex-basis: 100%;
                    min-width: 0;
                }

                #${BAR_ID} .command-editor-panel-send-group {
                    margin-left: auto;
                }
            }

            @container command-editor-panel (max-width: 480px) {
                #${BAR_ID} .command-editor-panel-toolbar {
                    gap: 5px;
                    padding: 5px 6px;
                }

                #${BAR_ID} .command-editor-panel-send-group {
                    order: 20;
                    width: 100%;
                    margin-left: 0;
                    justify-content: flex-end;
                }

                #${BAR_ID} .command-editor-panel-file-picker {
                    order: 10;
                }
            }

            #${BAR_ID} .command-editor-panel-file-history-button {
                flex: 1;
                min-width: 80px;
                overflow: hidden;
                padding: 2px 24px 2px 8px;
                font-size: 12px;
                text-align: left;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: var(--bs-body-color, #adb5bd);
                background-color: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.06));
                border-color: var(--bs-border-color, rgba(255, 255, 255, 0.15));
            }

            #${BAR_ID} .command-editor-panel-file-history-button:focus {
                color: var(--bs-body-color, #dee2e6);
                background-color: var(--bs-body-bg, rgba(0, 0, 0, 0.25));
            }

            #${BAR_ID} .command-editor-panel-file-history-menu {
                display: none;
                position: absolute;
                z-index: 220;
                top: calc(100% + 4px);
                left: 0;
                right: 0;
                max-height: min(280px, 45vh);
                overflow-y: auto;
                padding: 4px;
                border-radius: 4px;
                background: var(--bs-body-bg, rgba(16, 18, 22, 0.98));
                border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
            }

            #${BAR_ID} .command-editor-panel-file-history-menu.open {
                display: block;
            }

            #${BAR_ID} .command-editor-panel-file-history-item {
                display: flex;
                align-items: center;
                min-width: 0;
                border-radius: 3px;
            }

            #${BAR_ID} .command-editor-panel-file-history-item.active,
            #${BAR_ID} .command-editor-panel-file-history-item:hover {
                background: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.08));
            }

            #${BAR_ID} .command-editor-panel-file-history-open {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                padding: 5px 8px;
                border: 0;
                background: transparent;
                color: var(--bs-body-color, #dee2e6);
                text-align: left;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 12px;
                cursor: pointer;
            }

            #${BAR_ID} .command-editor-panel-file-history-remove {
                flex: none;
                width: 24px;
                height: 24px;
                padding: 0;
                border: 0;
                border-radius: 3px;
                background: transparent;
                color: var(--bs-secondary-color, #aaa);
                font-size: 16px;
                line-height: 1;
                cursor: pointer;
            }

            #${BAR_ID} .command-editor-panel-file-history-remove:hover {
                color: #fff;
                background: var(--bs-danger, #dc3545);
            }

            #${BAR_ID} .command-editor-panel-interval {
                display: inline-flex;
                align-items: center;
                gap: 2px;
                margin: 0;
                flex: none;
            }

            #${BAR_ID} .command-editor-panel-interval-input {
                width: 52px;
                padding: 1px 4px;
                font-size: 11px;
                font-family: monospace;
                color: var(--bs-body-color, #adb5bd);
                background-color: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.06));
                border-color: var(--bs-border-color, rgba(255, 255, 255, 0.15));
                -moz-appearance: textfield;
            }

            #${BAR_ID} .command-editor-panel-interval-input:focus {
                color: var(--bs-body-color, #dee2e6);
                background-color: var(--bs-body-bg, rgba(0, 0, 0, 0.25));
            }

            #${BAR_ID} .command-editor-panel-interval-input::-webkit-outer-spin-button,
            #${BAR_ID} .command-editor-panel-interval-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }

            #${BAR_ID} .command-editor-panel-loop-count-input {
                width: 36px;
                padding: 1px 4px;
                font-size: 11px;
                font-family: monospace;
                color: var(--bs-body-color, #adb5bd);
                background-color: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.06));
                border-color: var(--bs-border-color, rgba(255, 255, 255, 0.15));
                -moz-appearance: textfield;
            }

            #${BAR_ID} .command-editor-panel-loop-count-input::-webkit-outer-spin-button,
            #${BAR_ID} .command-editor-panel-loop-count-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }

            #${BAR_ID} .command-editor-panel-interval-unit-select {
                width: auto;
                min-width: 42px;
                padding: 1px 18px 1px 4px;
                font-size: 11px;
                font-family: monospace;
                line-height: 1.2;
                color: var(--bs-body-color, #adb5bd);
                background-color: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.06));
                border-color: var(--bs-border-color, rgba(255, 255, 255, 0.15));
            }

            #${BAR_ID} .command-editor-panel-interval-unit-select:focus {
                color: var(--bs-body-color, #dee2e6);
                background-color: var(--bs-body-bg, rgba(0, 0, 0, 0.25));
            }

            #${BAR_ID} .command-editor-panel-interval-unit {
                font-size: 11px;
                color: var(--bs-secondary-color, #aaa);
            }

            #${BAR_ID} .command-editor-panel-batch-status-container {
                display: none;
                flex: none;
                flex-direction: column;
                align-items: stretch;
                gap: 6px;
                padding: 6px 8px;
                max-height: min(280px, 45vh);
                overflow-y: auto;
                border-bottom: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.12));
            }

            #${BAR_ID} .command-editor-panel-batch-status-container.active {
                display: flex;
            }

            #${BAR_ID} .command-editor-panel-batch-job {
                display: flex;
                flex-direction: column;
                gap: 4px;
                padding: 6px 8px 6px 10px;
                border-left: 3px solid;
                border-radius: 3px;
                font-size: 12px;
                color: var(--bs-secondary-color, #ccc);
            }

            #${BAR_ID} .command-editor-panel-batch-job-header {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: none;
                min-width: 0;
            }

            #${BAR_ID} .command-editor-panel-batch-job-terminal {
                flex: none;
                max-width: 40%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 11px;
                font-weight: 700;
            }

            #${BAR_ID} .command-editor-panel-batch-job-label {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-family: monospace;
            }

            #${BAR_ID} .command-editor-panel-batch-job-preview {
                margin: 0;
                max-height: 88px;
                overflow: auto;
                padding: 6px 8px;
                border-radius: 3px;
                background: rgba(0, 0, 0, 0.22);
                color: var(--bs-body-color, #ddd);
                font-family: monospace;
                font-size: 11px;
                line-height: 1.45;
                white-space: pre-wrap;
                word-break: break-word;
            }

            #${BAR_ID} .command-editor-panel-batch-job-preview .batch-line-current {
                color: var(--loop-job-accent, var(--bs-primary, #4da3ff));
                font-weight: 600;
            }

            #${BAR_ID} .command-editor-panel-batch-job-close {
                flex: none;
                line-height: 1;
                padding: 0 8px;
            }

            #${BAR_ID} .command-editor-panel-editor-host {
                flex: 1;
                min-height: 0;
                overflow: hidden;
            }

            #${BAR_ID} .command-editor-outline-picker {
                position: absolute;
                top: 38px;
                left: 8px;
                right: 8px;
                max-height: min(320px, 40vh);
                overflow-y: auto;
                z-index: 200;
                padding: 4px 0;
                border-radius: 4px;
                background: var(--bs-body-bg, rgba(16, 18, 22, 0.98));
                border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
            }

            #${BAR_ID} .command-editor-outline-picker-title {
                padding: 6px 12px 4px;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                color: var(--bs-secondary-color, #888);
                border-bottom: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.1));
            }

            #${BAR_ID} .command-editor-outline-empty {
                padding: 12px;
                font-size: 12px;
                color: var(--bs-secondary-color, #888);
                text-align: center;
                line-height: 1.5;
            }

            #${BAR_ID} .command-editor-outline-item {
                display: flex;
                align-items: center;
                gap: 4px;
                width: 100%;
                border: 0;
                background: transparent;
                color: var(--bs-body-color, #dee2e6);
                text-align: left;
                padding: 6px 12px;
                font-size: 13px;
                cursor: pointer;
            }

            #${BAR_ID} .command-editor-outline-twistie {
                flex: none;
                width: 20px;
                font-size: 12px;
                line-height: 1;
                color: var(--bs-secondary-color, #888);
                text-align: center;
                user-select: none;
            }

            #${BAR_ID} .command-editor-outline-item.has-children .command-editor-outline-twistie {
                cursor: pointer;
                color: var(--bs-info, #5bc0de);
                font-size: 18px;
                font-weight: 700;
            }

            #${BAR_ID} .command-editor-outline-item.has-children .command-editor-outline-twistie:hover {
                color: var(--bs-primary, #4da3ff);
            }

            #${BAR_ID} .command-editor-outline-label {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: inherit;
            }

            #${BAR_ID} .command-editor-outline-item:hover,
            #${BAR_ID} .command-editor-outline-item:focus {
                background: rgba(255, 255, 255, 0.06);
                outline: none;
            }

            #${BAR_ID} .command-editor-outline-item.active {
                background: rgba(77, 163, 255, 0.1);
                box-shadow: inset 3px 0 0 var(--bs-primary, #4da3ff);
                outline: none;
            }

            #${BAR_ID} .command-editor-outline-item.active .command-editor-outline-label {
                color: var(--bs-body-color, #f0f0f0);
                font-weight: 600;
            }

            #${BAR_ID} .command-editor-outline-item.active .command-editor-outline-twistie {
                color: var(--bs-primary, #4da3ff);
            }

            #${BAR_ID} .command-editor-outline-item.level-1 { padding-left: 12px; }
            #${BAR_ID} .command-editor-outline-item.level-2 { padding-left: 24px; }
            #${BAR_ID} .command-editor-outline-item.level-3 { padding-left: 36px; }
            #${BAR_ID} .command-editor-outline-item.level-4 { padding-left: 48px; }
            #${BAR_ID} .command-editor-outline-item.level-5 { padding-left: 60px; }
            #${BAR_ID} .command-editor-outline-item.level-6 { padding-left: 72px; }

            /* Monaco Quick Access overlay: Go to Symbol (Ctrl+Shift+O),
               Go to Line (Ctrl+G), Command palette (>), Provider help (?) */
            #${BAR_ID} .quick-input-widget {
                padding: 0;
                border-radius: 6px;
                border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
                background: var(--bs-body-bg, rgba(16, 18, 22, 0.98)) !important;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5) !important;
                overflow: hidden;
            }

            #${BAR_ID} .quick-input-widget * {
                text-decoration: none !important;
            }

            #${BAR_ID} .quick-input-titlebar {
                background: transparent !important;
            }

            #${BAR_ID} .quick-input-header {
                padding: 8px 8px 6px;
                background: transparent;
            }

            #${BAR_ID} .quick-input-description {
                padding: 2px 4px 6px;
                font-size: 12px;
                color: var(--bs-secondary-color, #aaa);
            }

            #${BAR_ID} .quick-input-box .monaco-inputbox {
                border-radius: 4px;
                border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.2)) !important;
                background: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.06)) !important;
            }

            #${BAR_ID} .quick-input-box .monaco-inputbox > .ibwrapper > .input,
            #${BAR_ID} .quick-input-box .monaco-inputbox .input {
                background: transparent !important;
                color: var(--bs-body-color, #dee2e6) !important;
                font-size: 13px;
                padding: 4px 8px;
            }

            #${BAR_ID} .quick-input-box .monaco-inputbox.synthetic-focus,
            #${BAR_ID} .quick-input-box .monaco-inputbox:focus-within {
                border-color: var(--bs-primary, #4da3ff) !important;
                box-shadow: 0 0 0 1px var(--bs-primary, #4da3ff) !important;
            }

            #${BAR_ID} .quick-input-count .monaco-count-badge {
                min-width: 18px;
                padding: 1px 6px;
                border-radius: 10px;
                font-size: 11px;
                background: var(--bs-primary, #4da3ff) !important;
                color: #fff !important;
            }

            #${BAR_ID} .quick-input-message {
                padding: 4px 8px 6px;
                font-size: 11px;
                color: var(--bs-secondary-color, #aaa);
            }

            #${BAR_ID} .quick-input-list {
                padding: 4px 0 6px;
            }

            /* Keep rows at Monaco's measured fixed height; only restyle colors so
               the label is never clipped (no vertical padding/margin on rows). */
            #${BAR_ID} .quick-input-list .monaco-list-row {
                color: var(--bs-body-color, #dee2e6);
            }

            #${BAR_ID} .quick-input-list .monaco-list-row:hover {
                background: rgba(255, 255, 255, 0.06) !important;
            }

            #${BAR_ID} .quick-input-list .monaco-list-row.focused,
            #${BAR_ID} .quick-input-list .monaco-list.focused .monaco-list-row.focused {
                background: rgba(77, 163, 255, 0.18) !important;
                color: var(--bs-body-color, #f0f0f0) !important;
                box-shadow: inset 2px 0 0 var(--bs-primary, #4da3ff);
            }

            #${BAR_ID} .quick-input-list .quick-input-list-entry {
                align-items: center;
            }

            #${BAR_ID} .quick-input-list .monaco-icon-label,
            #${BAR_ID} .quick-input-list .monaco-icon-label > .monaco-icon-label-container {
                line-height: normal;
            }

            #${BAR_ID} .quick-input-list .monaco-highlighted-label .highlight {
                color: var(--bs-primary, #4da3ff) !important;
                font-weight: 700;
                background: transparent !important;
            }

            #${BAR_ID} .quick-input-list .label-description,
            #${BAR_ID} .quick-input-list .quick-input-list-label-meta,
            #${BAR_ID} .quick-input-list .quick-input-list-entry-description,
            #${BAR_ID} .quick-input-list .monaco-icon-label .label-description {
                color: var(--bs-secondary-color, #8a8f98) !important;
                font-size: 11px;
            }

            #${BAR_ID} .quick-input-list .monaco-keybinding-key {
                padding: 1px 5px;
                border-radius: 3px;
                font-size: 10px;
                background: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.1)) !important;
                color: var(--bs-body-color, #cfd3da) !important;
                border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.18)) !important;
                border-bottom-width: 2px !important;
                box-shadow: none !important;
            }

            #${BAR_ID} .quick-input-list .quick-input-list-separator,
            #${BAR_ID} .quick-input-list .quick-input-list-separator-label {
                color: var(--bs-secondary-color, #888) !important;
                font-size: 10px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }

            #${BAR_ID} .quick-input-list .quick-input-list-entry.quick-input-list-separator-border {
                border-top: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.12)) !important;
            }

            /* Preview highlight while navigating the picker (before accepting the jump) */
            #${BAR_ID} .monaco-editor .rangeHighlight {
                background: rgba(140, 140, 140, 0.32) !important;
            }

            /* Heading/comment line highlight after jumping from "Go to Symbol" */
            #${BAR_ID} .monaco-editor .command-editor-symbol-highlight {
                background: rgba(77, 163, 255, 0.20);
                box-shadow: inset 3px 0 0 var(--bs-primary, #4da3ff);
                animation: command-editor-symbol-flash 0.65s ease-out;
            }

            @keyframes command-editor-symbol-flash {
                0% { background: rgba(77, 163, 255, 0.55); }
                100% { background: rgba(77, 163, 255, 0.20); }
            }
        `
        document.head.appendChild(style)
    }

    private getTextToSend (editor: monaco.editor.IStandaloneCodeEditor, forceLine?: boolean): string {
        const selection = editor.getSelection()
        const model = editor.getModel()
        if (!model) {
            return ''
        }

        if (!forceLine && selection && !selection.isEmpty()) {
            return model.getValueInRange(selection)
        }

        const position = editor.getPosition()
        if (!position) {
            return ''
        }

        return model.getLineContent(position.lineNumber)
    }

    /** Selected line(s): expands partial selection to full lines. */
    private getSelectedLinesText (editor: monaco.editor.IStandaloneCodeEditor): string {
        const model = editor.getModel()
        if (!model) {
            return ''
        }

        let selection = editor.getSelection()
        if ((!selection || selection.isEmpty()) && this.savedEditorSelection) {
            selection = this.savedEditorSelection
        }
        if (!selection) {
            return ''
        }

        const startLine = selection.startLineNumber
        const endLine = selection.endLineNumber
        return model.getValueInRange(new monaco.Range(
            startLine,
            1,
            endLine,
            model.getLineMaxColumn(endLine),
        ))
    }

    private getSendLineIntervalUnit (): SendLineIntervalUnit {
        const unit = this.config.store.commandEditor?.sendLineIntervalUnit
        return unit === 'min' || unit === 'ms' ? unit : 's'
    }

    private getIntervalWheelStep (unit: SendLineIntervalUnit): number {
        switch (unit) {
            case 'min':
                return 1
            case 'ms':
                return 10
            default:
                return 0.1
        }
    }

    private applyIntervalInputStep (input: HTMLInputElement, unit: SendLineIntervalUnit): void {
        input.step = String(this.getIntervalWheelStep(unit))
    }

    private snapIntervalDisplayValue (value: number, unit: SendLineIntervalUnit): number {
        switch (unit) {
            case 'min':
                return Math.round(value)
            case 'ms':
                if (value === 0) {
                    return 0
                }
                return Math.max(10, Math.round(value / 10) * 10)
            default:
                return Math.round(value * 10) / 10
        }
    }

    private secToIntervalDisplay (sec: number, unit: SendLineIntervalUnit): number {
        const safeSec = Math.max(0, sec)
        switch (unit) {
            case 'min':
                return safeSec / 60
            case 'ms':
                return safeSec * 1000
            default:
                return safeSec
        }
    }

    private intervalDisplayToSec (value: number, unit: SendLineIntervalUnit): number {
        const snapped = this.snapIntervalDisplayValue(value, unit)
        switch (unit) {
            case 'min':
                return snapped * 60
            case 'ms':
                return snapped / 1000
            default:
                return snapped
        }
    }

    private formatIntervalDisplayValue (value: number, unit: SendLineIntervalUnit): string {
        const snapped = this.snapIntervalDisplayValue(value, unit)
        switch (unit) {
            case 'min':
            case 'ms':
                return String(snapped)
            default:
                return String(parseFloat(snapped.toFixed(1)))
        }
    }

    private setSendIntervalUnit (unit: SendLineIntervalUnit): void {
        const state = this.panel
        if (!state) {
            return
        }

        const sec = this.readSendIntervalSec(state)
        if (!this.config.store.commandEditor) {
            return
        }

        this.config.store.commandEditor.sendLineIntervalUnit = unit
        this.config.store.commandEditor.sendLineIntervalSec = sec
        this.applyIntervalInputStep(state.sendIntervalInput, unit)
        state.sendIntervalUnitSelect.value = unit
        state.sendIntervalInput.value = this.formatIntervalDisplayValue(
            this.secToIntervalDisplay(sec, unit),
            unit,
        )
        void this.config.save()
    }

    private adjustIntervalInput (state: PanelState, increase: boolean): void {
        const unit = this.getSendLineIntervalUnit()
        const step = this.getIntervalWheelStep(unit)
        const parsed = this.parseIntervalInput(state.sendIntervalInput.value)
        const current = parsed ?? this.secToIntervalDisplay(this.getSendLineIntervalSec(), unit)
        const next = Math.max(0, current + (increase ? step : -step))
        state.sendIntervalInput.value = this.formatIntervalDisplayValue(next, unit)
        this.persistSendIntervalInput(state)
    }

    private matchesConfiguredHotkey (event: KeyboardEvent, hotkeyId: string): boolean {
        const raw = (this.config.store.hotkeys as Record<string, string[] | string[][] | undefined> | undefined)?.[hotkeyId]
        if (!raw?.length) {
            return false
        }

        const sequences = typeof raw[0] === 'string'
            ? [raw as string[]]
            : raw as string[][]

        const stroke = this.eventToKeystroke(event)
        if (!stroke) {
            return false
        }

        return sequences.some(sequence => sequence[sequence.length - 1] === stroke)
    }

    /** Match Tabby hotkey stroke names (e.g. Ctrl-E) from a keydown event. */
    private eventToKeystroke (event: KeyboardEvent): string | null {
        if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
            return null
        }

        const parts: string[] = []
        if (event.ctrlKey) {
            parts.push('Ctrl')
        }
        if (event.metaKey) {
            parts.push(process.platform === 'darwin' ? '⌘' : process.platform === 'win32' ? 'Win' : 'Super')
        }
        if (event.altKey) {
            parts.push(process.platform === 'darwin' ? '⌥' : 'Alt')
        }
        if (event.shiftKey) {
            parts.push('Shift')
        }

        let key = event.code
        if (/^[a-z]$/i.test(event.key) && event.key.length === 1) {
            key = event.key.toUpperCase()
        } else {
            key = key
                .replace('Key', '')
                .replace('Arrow', '')
                .replace('Digit', '')
            key = ({
                Comma: ',',
                Period: '.',
                Slash: '/',
                Backslash: '\\',
                Minus: '-',
                Equal: '=',
                Semicolon: ';',
                Quote: '\'',
                BracketLeft: '[',
                BracketRight: ']',
            } as Record<string, string>)[key] ?? key
        }

        parts.push(key)
        return parts.join('-')
    }

    private parseIntervalInput (value: string): number | null {
        const trimmed = value.trim()
        if (!trimmed) {
            return null
        }

        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed) || parsed < 0) {
            return null
        }

        return parsed
    }

    private readSendIntervalSec (state: PanelState): number {
        const unit = this.getSendLineIntervalUnit()
        const parsed = this.parseIntervalInput(state.sendIntervalInput.value)
        if (parsed !== null) {
            return this.intervalDisplayToSec(parsed, unit)
        }

        return this.getSendLineIntervalSec()
    }

    private persistSendIntervalInput (state: PanelState): void {
        const unit = this.getSendLineIntervalUnit()
        const parsed = this.parseIntervalInput(state.sendIntervalInput.value)
        if (parsed === null) {
            state.sendIntervalInput.value = this.formatIntervalDisplayValue(
                this.secToIntervalDisplay(this.getSendLineIntervalSec(), unit),
                unit,
            )
            return
        }

        const sec = this.intervalDisplayToSec(parsed, unit)
        state.sendIntervalInput.value = this.formatIntervalDisplayValue(
            this.secToIntervalDisplay(sec, unit),
            unit,
        )
        if (!this.config.store.commandEditor) {
            return
        }

        this.config.store.commandEditor.sendLineIntervalSec = sec
        void this.config.save()
    }

    private getTerminalLabel (terminal: BaseTerminalTabComponent<any>): string {
        const tab = terminal as {
            title?: string
            customTitle?: string
            profile?: { name?: string; options?: { name?: string } }
        }
        return tab.title
            || tab.customTitle
            || tab.profile?.name
            || tab.profile?.options?.name
            || 'Terminal'
    }

    private createLoopJobElement (
        state: PanelState,
        jobId: number,
        terminalLabel: string,
        colorIndex: number,
    ): { root: HTMLElement; label: HTMLElement; preview: HTMLElement } {
        const palette = LOOP_JOB_COLORS[colorIndex % LOOP_JOB_COLORS.length]
        const root = document.createElement('div')
        root.className = 'command-editor-panel-batch-job'
        root.dataset.jobId = String(jobId)
        root.style.borderLeftColor = palette.border
        root.style.background = palette.bg

        const header = document.createElement('div')
        header.className = 'command-editor-panel-batch-job-header'

        const terminalBadge = document.createElement('span')
        terminalBadge.className = 'command-editor-panel-batch-job-terminal'
        terminalBadge.textContent = terminalLabel
        terminalBadge.style.color = palette.accent
        terminalBadge.title = terminalLabel

        const label = document.createElement('span')
        label.className = 'command-editor-panel-batch-job-label'

        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'command-editor-panel-batch-job-close btn btn-sm btn-outline-secondary'
        closeBtn.textContent = '×'
        closeBtn.title = 'Stop this loop'
        closeBtn.addEventListener('mousedown', (event: MouseEvent) => {
            event.preventDefault()
        })
        closeBtn.addEventListener('click', () => this.cancelLoopJob(jobId))

        header.append(terminalBadge, label, closeBtn)

        const preview = document.createElement('div')
        preview.className = 'command-editor-panel-batch-job-preview'
        preview.style.setProperty('--loop-job-accent', palette.accent)

        root.append(header, preview)
        state.batchStatusContainer.append(root)

        return { root, label, preview }
    }

    private createTabbyRunJobElement (
        state: PanelState,
        jobId: number,
        terminalLabel: string,
    ): { root: HTMLElement; label: HTMLElement; preview: HTMLElement } {
        const palette = LOOP_JOB_COLORS[jobId % LOOP_JOB_COLORS.length]
        const root = document.createElement('div')
        root.className = 'command-editor-panel-batch-job'
        root.style.borderLeftColor = palette.border
        root.style.background = palette.bg

        const header = document.createElement('div')
        header.className = 'command-editor-panel-batch-job-header'
        const terminalBadge = document.createElement('span')
        terminalBadge.className = 'command-editor-panel-batch-job-terminal'
        terminalBadge.style.color = palette.accent
        terminalBadge.textContent = terminalLabel
        const label = document.createElement('span')
        label.className = 'command-editor-panel-batch-job-label'
        label.textContent = 'Tabby · running'
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'command-editor-panel-batch-job-close btn btn-sm btn-outline-secondary'
        close.textContent = '×'
        close.title = 'Stop this Tabby background task'
        close.addEventListener('mousedown', event => event.preventDefault())
        close.addEventListener('click', () => this.removeTabbyRunJob(jobId, true))
        header.append(terminalBadge, label, close)

        const preview = document.createElement('div')
        preview.className = 'command-editor-panel-batch-job-preview'
        preview.style.setProperty('--loop-job-accent', palette.accent)
        root.append(header, preview)
        state.batchStatusContainer.append(root)
        return { root, label, preview }
    }

    private appendTabbyRunOutput (job: TabbyRunJob, line: string): void {
        if (!line) return
        const row = document.createElement('div')
        row.className = 'batch-line-current'
        row.textContent = line
        job.previewEl.append(row)
        while (job.previewEl.childElementCount > 100) job.previewEl.firstElementChild?.remove()
        job.previewEl.scrollTop = job.previewEl.scrollHeight
    }

    private removeTabbyRunJob (jobId: number, cancel: boolean): void {
        const job = this.tabbyRunJobs.get(jobId)
        if (!job) return
        this.tabbyRunJobs.delete(jobId)
        job.outputSubscription.unsubscribe()
        if (cancel) job.execution.cancel()
        job.rootEl.remove()
        if (this.panel) {
            this.syncBatchStatusContainer(this.panel)
            this.panel.editor.layout()
        }
    }

    private moveEditorToLine (
        editor: monaco.editor.IStandaloneCodeEditor,
        lineNumber: number,
    ): void {
        const model = editor.getModel()
        if (!model || lineNumber < 1 || lineNumber > model.getLineCount()) {
            return
        }

        editor.setSelection(new monaco.Selection(lineNumber, 1, lineNumber, 1))
        editor.revealLineInCenter(lineNumber)
    }

    private getScriptLanguageLabel (language: string): string {
        switch (language.toLowerCase()) {
            case 'py':
            case 'python':
                return 'Python'
            case 'bash':
            case 'sh':
            case 'shell':
                return 'bash'
            case 'powershell':
            case 'pwsh':
            case 'ps1':
                return 'PowerShell'
            default:
                return language
        }
    }

    private getCodeBlockRunSettings (): CodeBlockRunSettings {
        return resolveCodeBlockRunSettings(this.config.store.commandEditor)
    }

    private getRunnableLanguageFamilies (): string[] {
        return [...new Set(Object.values(this.getCodeBlockRunSettings().languageAliases))] as string[]
    }

    private syncBatchStatusContainer (state: PanelState): void {
        const visible = state.batchStatusContainer.childElementCount > 0
        state.batchStatusContainer.style.display = visible ? 'flex' : 'none'
        state.batchStatusContainer.classList.toggle('active', visible)
    }

    private renderLoopJobPreview (job: LoopSendJob, currentIndex: number): void {
        job.previewEl.replaceChildren()
        for (let index = 0; index < job.lines.length; index++) {
            const lineEl = document.createElement('div')
            lineEl.className = index === currentIndex ? 'batch-line-current' : 'batch-line'
            lineEl.textContent = job.lines[index]
            job.previewEl.append(lineEl)
        }
    }

    private updateLoopJobStatus (job: LoopSendJob, lineIndex: number, round: number): void {
        job.labelEl.textContent = this.formatBatchStatusLabel(round, job.loopCount, lineIndex, job.lines.length)
        this.renderLoopJobPreview(job, lineIndex)
    }

    private formatBatchStatusLabel (
        round: number,
        loopCount: number,
        lineIndex: number,
        lineCount: number,
    ): string {
        if (loopCount <= 1) {
            return `Loop ${lineIndex + 1}/${lineCount}`
        }

        return `Loop ${round + 1}/${loopCount} · ${lineIndex + 1}/${lineCount}`
    }

    private parseLoopCountInput (value: string): number | null {
        const trimmed = value.trim()
        if (!trimmed) {
            return null
        }

        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
            return null
        }

        return parsed
    }

    private readSendLoopCount (state: PanelState): number {
        const parsed = this.parseLoopCountInput(state.sendLoopCountInput.value)
        if (parsed !== null) {
            return parsed
        }

        return this.getSendLoopCount()
    }

    private persistSendLoopCountInput (input: HTMLInputElement): void {
        const parsed = this.parseLoopCountInput(input.value)
        if (parsed === null) {
            input.value = String(this.getSendLoopCount())
            return
        }

        input.value = String(parsed)
        if (!this.config.store.commandEditor) {
            return
        }

        this.config.store.commandEditor.sendLoopCount = parsed
        this.config.save()
    }

    private getSendLoopCount (): number {
        const value = this.config.store.commandEditor?.sendLoopCount
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && Number.isInteger(value)) {
            return value
        }
        return 1
    }

    private getSendLineIntervalSec (): number {
        let sec = this.config.store.commandEditor?.sendLineIntervalSec
        if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) {
            sec = 1
        }
        const unit = this.getSendLineIntervalUnit()
        return this.intervalDisplayToSec(this.secToIntervalDisplay(sec, unit), unit)
    }

    private sendLineToTerminal (terminal: BaseTerminalTabComponent<any>, line: string): void {
        if (!terminal.session) {
            throw new Error('Terminal session not ready')
        }
        terminal.sendInput(`${line}\r`)
    }

    private sendToTerminal (terminal: BaseTerminalTabComponent<any>, command: string): void {
        for (const line of this.getNonEmptyCommandLines(command)) {
            this.sendLineToTerminal(terminal, line)
        }
    }

    private getNonEmptyCommandLines (command: string): string[] {
        return command
            .replace(/\r\n/g, '\n')
            .split('\n')
            .filter(line => line.trim().length > 0)
    }

    private async sendCommandLinesWithInterval (
        terminal: BaseTerminalTabComponent<any>,
        lines: string[],
        delayMs: number,
    ): Promise<void> {
        for (let index = 0; index < lines.length; index++) {
            if (!terminal.session || !this.isTerminalTabAlive(terminal)) {
                return
            }

            this.sendLineToTerminal(terminal, lines[index])
            if (index + 1 < lines.length) {
                await new Promise<void>(resolve => window.setTimeout(resolve, delayMs))
            }
        }
    }

    private getLoopSendLines (editor: monaco.editor.IStandaloneCodeEditor): string[] {
        let raw = this.getSelectedLinesText(editor).replace(/\r\n/g, '\n').trimEnd()
        if (!raw.trim()) {
            raw = editor.getModel()?.getValue().replace(/\r\n/g, '\n').trimEnd() ?? ''
        }

        if (!raw.trim()) {
            return []
        }

        return stripComments(raw)
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line.trim().length > 0)
    }

    private resolveTerminalForSend (): BaseTerminalTabComponent<any> | null {
        // Always follow the currently focused tab so commands go where the user is looking.
        const active = this.getActiveTerminalTab()
        if (active) {
            this.targetTerminalTab = active
            return active
        }

        // No active terminal (e.g. a Settings tab is focused) 鈥?fall back to the last one.
        if (this.targetTerminalTab && this.isTerminalTabAlive(this.targetTerminalTab)) {
            return this.targetTerminalTab
        }

        this.targetTerminalTab = null
        return null
    }

    private isTerminalTabAlive (terminal: BaseTerminalTabComponent<any>): boolean {
        for (const tab of this.app.tabs) {
            if (this.containsTerminalTab(tab, terminal)) {
                return true
            }
        }
        return false
    }

    private containsTerminalTab (root: unknown, target: BaseTerminalTabComponent<any>): boolean {
        if (root === target) {
            return true
        }

        if (root instanceof SplitTabComponent) {
            for (const child of root.getAllTabs()) {
                if (this.containsTerminalTab(child, target)) {
                    return true
                }
            }
        }

        return false
    }

    private findTerminalInTab (tab: unknown): BaseTerminalTabComponent<any> | null {
        if (tab instanceof BaseTerminalTabComponent) {
            return tab
        }

        if (tab instanceof SplitTabComponent) {
            const focused = tab.getFocusedTab()
            if (focused) {
                const fromFocused = this.findTerminalInTab(focused)
                if (fromFocused) {
                    return fromFocused
                }
            }
            for (const child of tab.getAllTabs()) {
                const fromChild = this.findTerminalInTab(child)
                if (fromChild) {
                    return fromChild
                }
            }
        }

        return null
    }

    private getEditorTheme (): string {
        const rootStyle = getComputedStyle(document.documentElement)
        const bodyStyle = getComputedStyle(document.body)
        const scheme = this.config.store.terminal?.colorScheme
        const background = this.normalizeCssColor(
            rootStyle.getPropertyValue('--bs-body-bg') || bodyStyle.backgroundColor || scheme?.background,
        ) ?? '#1e1e1e'
        const foreground = this.normalizeCssColor(
            rootStyle.getPropertyValue('--bs-body-color') || bodyStyle.color || scheme?.foreground,
        ) ?? (this.isDarkColor(background) ? '#d4d4d4' : '#24292f')
        return defineCommandEditorThemeColors(this.isDarkColor(background), background, foreground)
    }

    private applyEditorTheme (): void {
        if (!this.panel?.editor) {
            return
        }
        monaco.editor.setTheme(this.getEditorTheme())
    }

    private normalizeCssColor (value: string | undefined): string | null {
        const color = value?.trim()
        if (!color) {
            return null
        }
        const hex = color.match(/^#([\da-f]{3,8})$/i)
        if (hex) {
            const digits = hex[1]
            if (digits.length === 3 || digits.length === 4) {
                return `#${[...digits].map(char => char + char).join('')}`
            }
            return `#${digits}`
        }
        const rgb = color.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+)%?)?\s*\)$/i)
        if (!rgb) {
            return null
        }
        const channels = rgb.slice(1, 4).map(part => this.toHexChannel(Number(part)))
        if (rgb[4] === undefined) {
            return `#${channels.join('')}`
        }
        const alpha = Math.max(0, Math.min(1, Number(rgb[4])))
        return `#${channels.join('')}${this.toHexChannel(alpha * 255)}`
    }

    private toHexChannel (value: number): string {
        return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
    }

    private isDarkColor (color: string): boolean {
        const hex = color.slice(1)
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
    }
}
