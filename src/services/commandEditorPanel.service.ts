import { Injectable, NgZone } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, ConfigService, NotificationsService, PlatformService, SplitTabComponent, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { splitMarkdownCommentNewline, stripComments, toggleMarkdownComment } from '../commandComments'
import { COMMAND_EDITOR_LANGUAGE, registerCommandEditorLanguage, resolveCommandEditorTheme } from '../commandEditorLanguage'
import { registerMarkdownHeadingFeatures, showHeadingOutlinePicker, closeHeadingOutlinePicker, pruneQuickAccessProviders } from '../commandOutline'
import { findPythonCodeBlockAtCursor, PythonExecution, runPythonCode } from '../pythonCodeBlockRunner'
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
const SEND_INTERVAL_STEP_SEC = 0.01
const LOOP_JOB_COLORS = [
    { border: '#4da3ff', bg: 'rgba(77, 163, 255, 0.14)', accent: '#4da3ff' },
    { border: '#4ec9b0', bg: 'rgba(78, 201, 176, 0.14)', accent: '#4ec9b0' },
    { border: '#c586c0', bg: 'rgba(197, 134, 192, 0.14)', accent: '#c586c0' },
    { border: '#dcdcaa', bg: 'rgba(220, 220, 170, 0.14)', accent: '#dcdcaa' },
    { border: '#f48771', bg: 'rgba(244, 135, 113, 0.14)', accent: '#f48771' },
    { border: '#569cd6', bg: 'rgba(86, 156, 214, 0.14)', accent: '#569cd6' },
] as const

type PanelPosition = 'bottom' | 'right'
type PythonLogMode = 'notification' | 'file'

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

interface PythonRunJob {
    id: number
    terminal: BaseTerminalTabComponent<any>
    terminalLabel: string
    logFilePath: string
    execution: PythonExecution
    rootEl: HTMLElement
    labelEl: HTMLElement
    previewEl: HTMLElement
}

interface PanelState {
    root: HTMLElement
    resizeHandle: HTMLElement
    editorHost: HTMLElement
    editor: monaco.editor.IStandaloneCodeEditor
    fileLabel: HTMLElement
    sendIntervalInput: HTMLInputElement
    sendLoopCountInput: HTMLInputElement
    loopSendBtn: HTMLButtonElement
    runCodeBtn: HTMLButtonElement
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
    private nextPythonRunJobId = 0
    private nextLoopSendColorIndex = 0
    private readonly loopSendJobs = new Map<number, LoopSendJob>()
    private readonly pythonRunJobs = new Map<number, PythonRunJob>()
    private readonly terminalLoopColors = new Map<BaseTerminalTabComponent<any>, number>()
    private lastPythonLogFilePath: string | null = null
    private savedEditorSelection: monaco.Selection | null = null
    private symbolHighlightIds: string[] = []
    private targetTerminalTab: BaseTerminalTabComponent<any> | null = null
    private suppressResizeHandler = false
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
        if (this.matchesConfiguredHotkey(event, 'run-command-editor-python')) {
            return () => this.runCurrentPythonCodeBlock()
        }
        if (this.matchesConfiguredHotkey(event, 'toggle-command-editor-python-log')) {
            return () => this.togglePythonLogMode()
        }
        if (this.matchesConfiguredHotkey(event, 'open-command-editor-python-log')) {
            return () => this.openPythonLogFolder()
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

        if (!(event.ctrlKey || event.metaKey)) {
            return
        }

        if (findWidgetVisible) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.stopImmediatePropagation()
                this.sendFromPanel(undefined, true)
                return
            }
            if (event.key === 'Enter' && event.shiftKey) {
                event.preventDefault()
                event.stopImmediatePropagation()
                const block = findPythonCodeBlockAtCursor(this.panel.editor)
                if (block) {
                    void this.runCurrentPythonCodeBlock()
                } else {
                    void this.sendLinesWithInterval()
                }
                return
            }
        }

        const key = event.key.toLowerCase()

        if (this.isMonacoOverlayInput(target)) {
            event.stopImmediatePropagation()
            if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
                return
            }

            if (key === 'v') {
                event.preventDefault()
                const text = this.readClipboardText()
                if (text) {
                    this.pasteIntoInput(target, text)
                }
                return
            }
            if (key === 'c') {
                event.preventDefault()
                this.copyFromInput(target)
                return
            }
            if (key === 'x') {
                event.preventDefault()
                this.cutFromInput(target)
                return
            }
            if (key === 'a') {
                event.preventDefault()
                target.select()
            }
            return
        }

        const editor = this.panel.editor

        if (key === 'c') {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.copyFromEditor(editor)
            return
        }
        if (key === 'v') {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.pasteIntoEditor(editor)
            return
        }
        if (key === 'x') {
            event.preventDefault()
            event.stopImmediatePropagation()
            this.cutFromEditor(editor)
            return
        }
        if (key === 'a') {
            event.preventDefault()
            event.stopImmediatePropagation()
            editor.trigger('keyboard', 'editor.action.selectAll', null)
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
        private zone: NgZone,
    ) {
        document.addEventListener('keydown', this.onPanelHotkeyCapture, true)
        document.addEventListener('keydown', this.onDocumentKeyCapture, true)
        this.app.ready$.subscribe(() => {
            const filePath = this.config.store.commandEditor?.lastOpenedFile
            if (filePath && typeof filePath === 'string') {
                this.pendingLastOpenedFile = filePath
            }
        })
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
            this.notifications.info(this.translate.instant('No active terminal'))
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
            this.notifications.error(this.translate.instant('Failed to open command editor panel'))
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
        this.notifications.notice(this.translate.instant('File saved'))
    }

    async reloadFile (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.ensurePanel()
        if (!state.visible) {
            this.showPanel(state, this.getActiveTerminalTab())
        }

        const filePath = state.filePath ?? this.config.store.commandEditor?.lastOpenedFile ?? null
        if (!filePath || typeof filePath !== 'string') {
            this.notifications.info(this.translate.instant('No file open'))
            return
        }

        if (!this.loadFileFromPath(state, filePath)) {
            this.notifications.error(this.translate.instant('File not found'))
            return
        }

        this.persistLastOpenedFile(filePath)
        this.notifications.notice(this.translate.instant('File reloaded'))
        state.editor.layout()
        state.editor.focus()
    }

    sendFromPanel (_terminal?: BaseTerminalTabComponent<any> | null, forceLine?: boolean): void {
        const state = this.panel
        const terminalTab = _terminal ?? this.resolveTerminalForSend()
        if (!state?.visible || !terminalTab) {
            if (!terminalTab) {
                this.notifications.info(this.translate.instant('No active terminal'))
            }
            return
        }

        const text = stripComments(this.getTextToSend(state.editor, forceLine))
        if (!text.trim()) {
            this.notifications.info(this.translate.instant('Nothing to send'))
            return
        }

        this.sendToTerminal(terminalTab, text)
    }

    async runCurrentPythonCodeBlock (): Promise<void> {
        const state = this.panel
        const terminal = this.resolveTerminalForSend()
        if (!state?.visible || !terminal) {
            if (!terminal) {
                this.notifications.info(this.translate.instant('No active terminal'))
            }
            return
        }

        const block = findPythonCodeBlockAtCursor(state.editor)
        if (!block) {
            this.notifications.info('Place the cursor inside a ```python or ```py code block')
            return
        }
        if (!block.code.trim()) {
            this.notifications.info('Python code block is empty')
            return
        }

        const jobId = ++this.nextPythonRunJobId
        const terminalLabel = this.getTerminalLabel(terminal)
        const colorIndex = this.getTerminalColorIndex(terminal)
        let sentCount = 0
        const jobUi = this.createPythonJobElement(
            state,
            jobId,
            terminalLabel,
            colorIndex,
            block.code,
        )
        const execution = runPythonCode(
            block.code,
            line => {
                if (!this.pythonRunJobs.has(jobId)) {
                    return
                }
                if (!line.trim() || !this.isTerminalTabAlive(terminal) || !terminal.session) {
                    return
                }
                this.sendLineToTerminal(terminal, line)
                sentCount++
            },
            line => this.showPythonLog(jobId, line),
        )
        this.pythonRunJobs.set(jobId, {
            id: jobId,
            terminal,
            terminalLabel,
            logFilePath: this.buildPythonLogFilePath(terminal),
            execution,
            rootEl: jobUi.root,
            labelEl: jobUi.label,
            previewEl: jobUi.preview,
        })
        this.syncBatchStatusContainer(state)
        state.editor.layout()

        try {
            await execution.promise
            if (!this.pythonRunJobs.has(jobId)) {
                return
            }
            if (sentCount === 0) {
                this.notifications.info(`${terminalLabel}: Python completed without output`)
                return
            }

            this.notifications.notice(`${terminalLabel}: Python output sent to terminal`)
        } catch (error) {
            if (!this.pythonRunJobs.has(jobId)) {
                return
            }
            const message = error instanceof Error ? error.message : 'Python execution failed'
            if (message !== 'Python execution cancelled') {
                console.error('[CommandEditor] Python execution failed:', error)
                this.notifications.error(`${terminalLabel}: ${message}`)
            }
        } finally {
            if (this.pythonRunJobs.has(jobId)) {
                this.removePythonRunJob(jobId, false)
                state.editor.focus()
            }
        }
    }

    private removePythonRunJob (jobId: number, cancel: boolean): void {
        const job = this.pythonRunJobs.get(jobId)
        if (!job) {
            return
        }

        this.pythonRunJobs.delete(jobId)
        if (cancel) {
            job.execution.cancel()
        }
        job.rootEl.remove()
        if (this.panel) {
            this.syncBatchStatusContainer(this.panel)
            this.panel.editor.layout()
        }
        if (cancel) {
            this.notifications.info(`${job.terminalLabel}: Python execution stopped`)
        }
    }

    private cancelAllPythonRuns (): void {
        for (const jobId of [...this.pythonRunJobs.keys()]) {
            this.removePythonRunJob(jobId, true)
        }
    }

    async sendLinesWithInterval (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.panel
        if (!state?.visible) {
            return
        }

        if (!state.batchStatusContainer || !state.sendIntervalInput || !state.sendLoopCountInput) {
            this.notifications.error(this.translate.instant('Loop send failed'))
            console.warn('[CommandEditorPanel] Panel UI outdated — close and reopen the panel (Ctrl+E)')
            return
        }

        const terminalTab = _terminal ?? this.getActiveTerminalTab()
        if (!terminalTab) {
            this.notifications.info(this.translate.instant('No active terminal'))
            return
        }

        if (!terminalTab.session) {
            this.notifications.error(this.translate.instant('Terminal session not ready'))
            console.warn('[CommandEditorPanel] Loop send blocked: terminal.session is null')
            return
        }

        const lines = this.getLoopSendLines(state.editor)
        if (lines.length === 0) {
            this.notifications.info(this.translate.instant('Nothing to send'))
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
        if (this.loopSendJobs.size === 0) {
            return
        }

        this.cancelAllLoopJobs()
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
                this.notifications.notice(`${terminalLabel}: ${this.translate.instant('Lines sent')} (${sentCount})`)
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
                this.notifications.error(this.translate.instant('Loop send failed'))
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

        for (const job of [...this.pythonRunJobs.values()]) {
            if (!this.isTerminalTabAlive(job.terminal)) {
                this.removePythonRunJob(job.id, true)
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

        if (this.panel && !this.panel.runCodeBtn) {
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
        const fileLabel = document.createElement('span')
        fileLabel.className = 'command-editor-panel-file-label'
        fileLabel.title = ''

        const sendGroup = document.createElement('div')
        sendGroup.className = 'command-editor-panel-send-group'

        const intervalWrap = document.createElement('label')
        intervalWrap.className = 'command-editor-panel-interval'
        intervalWrap.title = 'Scroll to adjust interval (10ms step)'

        const sendIntervalInput = document.createElement('input')
        sendIntervalInput.type = 'number'
        sendIntervalInput.className = 'command-editor-panel-interval-input form-control form-control-sm'
        sendIntervalInput.min = '0'
        sendIntervalInput.step = String(SEND_INTERVAL_STEP_SEC)
        sendIntervalInput.value = this.formatIntervalSecForInput(this.getSendLineIntervalSec())

        const intervalUnit = document.createElement('span')
        intervalUnit.className = 'command-editor-panel-interval-unit'
        intervalUnit.textContent = 's'

        intervalWrap.append(sendIntervalInput, intervalUnit)

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

        const loopSendBtn = mkBtn('Loop')
        loopSendBtn.title = 'F7'

        const runCodeBtn = mkBtn('Run')
        runCodeBtn.title = 'F9'

        const sendBtn = mkBtn('Send', true)
        sendBtn.title = 'Enter/F8'

        sendGroup.append(intervalWrap, loopCountWrap, loopSendBtn, runCodeBtn, sendBtn)
        toolbar.append(openBtn, saveBtn, closeBtn, fileLabel, sendGroup)

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
            scrollbar: {
                vertical: 'auto',
                horizontal: 'hidden',
                useShadows: false,
            },
            overviewRulerLanes: 0,
        })

        openBtn.addEventListener('click', () => this.openFile())
        saveBtn.addEventListener('click', () => this.saveFile())
        closeBtn.addEventListener('click', () => this.closeFile())
        sendBtn.addEventListener('click', () => this.sendFromPanel())
        loopSendBtn.addEventListener('mousedown', (event: MouseEvent) => {
            event.preventDefault()
            this.savedEditorSelection = editor.getSelection()
        })
        loopSendBtn.addEventListener('click', () => void this.sendLinesWithInterval())
        runCodeBtn.addEventListener('click', () => void this.runCurrentPythonCodeBlock())
        sendIntervalInput.addEventListener('change', () => this.persistSendIntervalInput(sendIntervalInput))
        sendIntervalInput.addEventListener('wheel', (event: WheelEvent) => {
            event.preventDefault()
            this.adjustIntervalInput(sendIntervalInput, event.deltaY < 0 ? SEND_INTERVAL_STEP_SEC : -SEND_INTERVAL_STEP_SEC)
        }, { passive: false })
        sendLoopCountInput.addEventListener('change', () => this.persistSendLoopCountInput(sendLoopCountInput))

        this.setupEditorKeybindings(editor)

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
            fileLabel,
            sendIntervalInput,
            sendLoopCountInput,
            loopSendBtn,
            runCodeBtn,
            batchStatusContainer,
            filePath: null,
            visible: false,
            panelSizePx: 0,
        }
        this.applyPendingLastOpenedFile(this.panel)
        return this.panel
    }

    private applyPendingLastOpenedFile (state: PanelState): void {
        if (!this.pendingLastOpenedFile) {
            return
        }

        const filePath = this.pendingLastOpenedFile
        this.pendingLastOpenedFile = null

        if (!this.loadFileFromPath(state, filePath) && this.config.store.commandEditor) {
            this.config.store.commandEditor.lastOpenedFile = null
            this.config.save()
        }
    }

    private persistLastOpenedFile (filePath: string): void {
        if (!this.config.store.commandEditor) {
            return
        }
        this.config.store.commandEditor.lastOpenedFile = filePath
        this.config.save()
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
        return true
    }

    private updateFileLabel (state: PanelState): void {
        if (!state.filePath) {
            state.fileLabel.textContent = ''
            state.fileLabel.title = ''
            return
        }

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path') as typeof import('path')
        state.fileLabel.textContent = path.basename(state.filePath)
        state.fileLabel.title = state.filePath
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
        this.cancelAllPythonRuns()
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
        const editorContext = 'editorTextFocus && !findWidgetVisible && !suggestWidgetVisible'

        editor.addCommand(monaco.KeyCode.Enter, send, editorContext)
        editor.addCommand(monaco.KeyCode.F8, send, editorContext)
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
            () => toggleMarkdownComment(editor),
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

    private pasteIntoInput (input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
        const start = input.selectionStart ?? input.value.length
        const end = input.selectionEnd ?? start
        input.setRangeText(text, start, end, 'end')
        input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    private copyFromInput (input: HTMLInputElement | HTMLTextAreaElement): void {
        const start = input.selectionStart ?? 0
        const end = input.selectionEnd ?? 0
        if (start === end) {
            return
        }

        this.writeClipboardText(input.value.slice(start, end))
    }

    private cutFromInput (input: HTMLInputElement | HTMLTextAreaElement): void {
        const start = input.selectionStart ?? 0
        const end = input.selectionEnd ?? 0
        if (start === end) {
            return
        }

        const text = input.value.slice(start, end)
        this.writeClipboardText(text)
        input.setRangeText('', start, end, 'end')
        input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    private copyFromEditor (editor: monaco.editor.IStandaloneCodeEditor): void {
        const selection = editor.getSelection()
        const model = editor.getModel()
        if (!selection || !model || selection.isEmpty()) {
            return
        }

        const text = model.getValueInRange(selection)
        if (text) {
            this.writeClipboardText(text)
        }
    }

    private pasteIntoEditor (editor: monaco.editor.IStandaloneCodeEditor): void {
        const text = this.readClipboardText()
        if (!text) {
            return
        }

        const selection = editor.getSelection()
        if (selection) {
            editor.executeEdits('paste', [{ range: selection, text, forceMoveMarkers: true }])
        }
    }

    private cutFromEditor (editor: monaco.editor.IStandaloneCodeEditor): void {
        const selection = editor.getSelection()
        const model = editor.getModel()
        if (!selection || !model || selection.isEmpty()) {
            return
        }

        const text = model.getValueInRange(selection)
        if (!text) {
            return
        }

        this.writeClipboardText(text)
        editor.executeEdits('cut', [{ range: selection, text: '', forceMoveMarkers: true }])
    }

    private readClipboardText (): string {
        const fromPlatform = this.platform.readClipboard()
        if (fromPlatform) {
            return fromPlatform
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { clipboard } = require('@electron/remote') as { clipboard: { readText: () => string } }
            return clipboard.readText() ?? ''
        } catch {
            return ''
        }
    }

    private writeClipboardText (text: string): void {
        this.platform.setClipboard({ text })
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { clipboard } = require('@electron/remote') as { clipboard: { writeText: (value: string) => void } }
            clipboard.writeText(text)
        } catch {
            // PlatformService is the primary path
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
                gap: 8px;
                padding: 6px 8px;
                align-items: center;
                flex: none;
                border-bottom: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
            }

            #${BAR_ID} .command-editor-panel-send-group {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-left: auto;
                flex: none;
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

            #${BAR_ID} .command-editor-panel-file-label {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 12px;
                color: var(--bs-secondary-color, #aaa);
                padding: 0 4px;
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

    private formatIntervalSecForInput (sec: number): string {
        const rounded = Math.round(Math.max(0, sec) * 100) / 100
        return String(parseFloat(rounded.toFixed(2)))
    }

    private adjustIntervalInput (input: HTMLInputElement, deltaSec: number): void {
        const current = this.parseIntervalInput(input.value) ?? this.getSendLineIntervalSec()
        const next = Math.max(0, Math.round((current + deltaSec) * 100) / 100)
        input.value = this.formatIntervalSecForInput(next)
        this.persistSendIntervalInput(input)
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
        const parsed = this.parseIntervalInput(state.sendIntervalInput.value)
        if (parsed !== null) {
            return parsed
        }

        return this.getSendLineIntervalSec()
    }

    private persistSendIntervalInput (input: HTMLInputElement): void {
        const parsed = this.parseIntervalInput(input.value)
        if (parsed === null) {
            input.value = this.formatIntervalSecForInput(this.getSendLineIntervalSec())
            return
        }

        input.value = this.formatIntervalSecForInput(parsed)
        if (!this.config.store.commandEditor) {
            return
        }

        this.config.store.commandEditor.sendLineIntervalSec = parsed
        this.config.save()
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

    private createPythonJobElement (
        state: PanelState,
        jobId: number,
        terminalLabel: string,
        colorIndex: number,
        code: string,
    ): { root: HTMLElement; label: HTMLElement; preview: HTMLElement } {
        const palette = LOOP_JOB_COLORS[colorIndex % LOOP_JOB_COLORS.length]
        const root = document.createElement('div')
        root.className = 'command-editor-panel-batch-job'
        root.dataset.pythonJobId = String(jobId)
        root.style.borderLeftColor = palette.border
        root.style.background = palette.bg

        const header = document.createElement('div')
        header.className = 'command-editor-panel-batch-job-header'

        const terminalBadge = document.createElement('span')
        terminalBadge.className = 'command-editor-panel-batch-job-terminal'
        terminalBadge.textContent = terminalLabel
        terminalBadge.style.color = palette.accent
        terminalBadge.title = `Bound terminal: ${terminalLabel}`

        const label = document.createElement('span')
        label.className = 'command-editor-panel-batch-job-label'
        label.textContent = 'Python · running'

        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'command-editor-panel-batch-job-close btn btn-sm btn-outline-secondary'
        closeBtn.textContent = '×'
        closeBtn.title = 'Stop this Python run'
        closeBtn.addEventListener('mousedown', (event: MouseEvent) => {
            event.preventDefault()
        })
        closeBtn.addEventListener('click', () => this.removePythonRunJob(jobId, true))

        header.append(terminalBadge, label, closeBtn)

        const preview = document.createElement('div')
        preview.className = 'command-editor-panel-batch-job-preview'
        preview.style.setProperty('--loop-job-accent', palette.accent)
        preview.textContent = code.trim().split(/\r?\n/).slice(0, 3).join('\n')

        root.append(header, preview)
        state.batchStatusContainer.append(root)
        return { root, label, preview }
    }

    private showPythonLog (jobId: number, line: string): void {
        const job = this.pythonRunJobs.get(jobId)
        const message = line.trim()
        if (!job || !message) {
            return
        }

        if (job.labelEl.textContent !== 'Python · log') {
            job.labelEl.textContent = 'Python · log'
            job.previewEl.replaceChildren()
        }
        const logLine = document.createElement('div')
        logLine.className = 'batch-line-current'
        logLine.textContent = message
        job.previewEl.append(logLine)
        while (job.previewEl.childElementCount > 50) {
            job.previewEl.firstElementChild?.remove()
        }
        job.previewEl.scrollTop = job.previewEl.scrollHeight
        if (this.getPythonLogMode() === 'file') {
            this.appendPythonLog(job, message)
        } else {
            this.notifications.info(`${job.terminalLabel}: ${message}`)
        }
    }

    private getPythonLogMode (): PythonLogMode {
        return this.config.store.commandEditor?.pythonLogMode === 'file'
            ? 'file'
            : 'notification'
    }

    togglePythonLogMode (): void {
        const nextMode: PythonLogMode = this.getPythonLogMode() === 'notification'
            ? 'file'
            : 'notification'
        if (this.config.store.commandEditor) {
            this.config.store.commandEditor.pythonLogMode = nextMode
            void this.config.save()
        }
        this.notifications.notice(nextMode === 'file'
            ? `Python logs will be written to ${this.getPythonLogDirectory()}`
            : 'Python logs will be shown as notifications')
    }

    private appendPythonLog (job: PythonRunJob, message: string): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs') as typeof import('fs')
            fs.mkdirSync(this.getPythonLogDirectory(), { recursive: true })
            fs.appendFileSync(job.logFilePath, `${message}\n`, 'utf8')
            this.lastPythonLogFilePath = job.logFilePath
        } catch (error) {
            console.error('[CommandEditor] Failed to write Python log:', error)
            this.notifications.error('Failed to write Python log file')
        }
    }

    private getPythonLogDirectory (): string {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path') as typeof import('path')
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os') as typeof import('os')
        const configPath = this.platform.getConfigPath()
        const baseDirectory = configPath
            ? path.dirname(configPath)
            : path.join(os.homedir(), '.tabby')
        return path.join(baseDirectory, 'logs', 'tabby-command-editor')
    }

    private buildPythonLogFilePath (terminal: BaseTerminalTabComponent<any>): string {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path') as typeof import('path')
        const tab = terminal as {
            title?: string
            customTitle?: string
            profile?: { name?: string }
        }
        const terminalName = tab.customTitle || tab.title || tab.profile?.name || 'terminal'
        const safeName = terminalName
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .trim()
            .substring(0, 80) || 'terminal'
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        return path.join(this.getPythonLogDirectory(), `${safeName}-${stamp}.log`)
    }

    openPythonLogFolder (): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs') as typeof import('fs')
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require('path') as typeof import('path')
            const logDirectory = this.getPythonLogDirectory()
            fs.mkdirSync(logDirectory, { recursive: true })

            let logFilePath = this.lastPythonLogFilePath
            if (!logFilePath || !fs.existsSync(logFilePath)) {
                const files = fs.readdirSync(logDirectory)
                    .filter(name => name.endsWith('.log'))
                    .map(name => path.join(logDirectory, name))
                    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
                logFilePath = files[0] ?? null
            }

            if (logFilePath) {
                this.platform.showItemInFolder(logFilePath)
            } else {
                this.platform.openPath(logDirectory)
            }
        } catch (error) {
            console.error('[CommandEditor] Failed to open Python log folder:', error)
            this.notifications.error('Failed to open Python log folder')
        }
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
        const value = this.config.store.commandEditor?.sendLineIntervalSec
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return value
        }
        return 1
    }

    private sendLineToTerminal (terminal: BaseTerminalTabComponent<any>, line: string): void {
        if (!terminal.session) {
            throw new Error('Terminal session not ready')
        }
        terminal.sendInput(`${line}\r`)
    }

    private sendToTerminal (terminal: BaseTerminalTabComponent<any>, command: string): void {
        let lines = command.replace(/\r\n/g, '\n').split('\n')
        while (lines.length > 1 && lines[lines.length - 1] === '') {
            lines.pop()
        }

        for (const line of lines) {
            if (!line.trim()) {
                continue
            }
            this.sendLineToTerminal(terminal, line)
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
        const scheme = this.config.store.terminal?.colorScheme
        if (scheme?.background?.startsWith('#')) {
            const bg = scheme.background
            const r = parseInt(bg.slice(1, 3), 16)
            const g = parseInt(bg.slice(3, 5), 16)
            const b = parseInt(bg.slice(5, 7), 16)
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
            return resolveCommandEditorTheme(luminance < 0.5)
        }
        return resolveCommandEditorTheme(true)
    }
}
