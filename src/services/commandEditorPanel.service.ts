import { Injectable, NgZone } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, ConfigService, NotificationsService, PlatformService, SplitTabComponent, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { stripComments, toggleMarkdownComment } from '../commandComments'
import { COMMAND_EDITOR_LANGUAGE, registerCommandEditorLanguage, resolveCommandEditorTheme } from '../commandEditorLanguage'
import { registerMarkdownHeadingFeatures, showHeadingOutlinePicker, closeHeadingOutlinePicker } from '../commandOutline'
// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

const STYLE_ID = 'tabby-command-editor-panel-style'
const BAR_ID = 'tabby-command-editor-panel-bar'
const BODY_CLASS = 'tabby-command-editor-panel-enabled'
const BROADCAST_BAR_ID = 'tabby-broadcast-input-bar'
const TAB_CONTENT_SELECTOR = 'app-root > .content > .content'
const PANEL_SIZE_VAR = '--tabby-command-editor-panel-size'
const CONTENT_TAB_SELECTOR = 'app-root .content > .content > .content-tab.content-tab-active, app-root > .content > .content > .content-tab.content-tab-active'
const PLUGIN_BUILD_ID = '20260530-loop5'
const SEND_INTERVAL_STEP_SEC = 0.01
const TOGGLE_PANEL_HOTKEY_ID = 'toggle-command-editor-panel'

type PanelPosition = 'bottom' | 'right'

interface PanelState {
    root: HTMLElement
    resizeHandle: HTMLElement
    editorHost: HTMLElement
    editor: monaco.editor.IStandaloneCodeEditor
    fileLabel: HTMLElement
    sendIntervalInput: HTMLInputElement
    sendLoopCountInput: HTMLInputElement
    loopSendBtn: HTMLButtonElement
    batchStatusBar: HTMLElement
    batchStatusHeader: HTMLElement
    batchStatusLabel: HTMLElement
    batchStatusPreview: HTMLElement
    batchStatusCloseBtn: HTMLButtonElement
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
    private batchSendJobId = 0
    private savedEditorSelection: monaco.Selection | null = null
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
    private readonly onToggleHotkeyCapture = (event: KeyboardEvent): void => {
        if (event.type !== 'keydown' || event.repeat) {
            return
        }

        if (!this.matchesConfiguredHotkey(event, TOGGLE_PANEL_HOTKEY_ID)) {
            return
        }

        // xterm handles keydown on the focused terminal before Tabby hotkey bubble runs,
        // so Ctrl+E would reach the serial session as 0x05 (ENQ) unless we swallow it here.
        event.preventDefault()
        event.stopImmediatePropagation()
        void this.togglePanel()
    }

    private readonly onDocumentKeyCapture = (event: KeyboardEvent): void => {
        if (!this.panel?.visible || !this.editorFocused) {
            return
        }

        const target = event.target as Node | null
        if (!target || !this.panel.editorHost.contains(target)) {
            return
        }

        if (!(event.ctrlKey || event.metaKey)) {
            return
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
        document.addEventListener('keydown', this.onToggleHotkeyCapture, true)
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

    sendFromPanel (_terminal?: BaseTerminalTabComponent<any> | null): void {
        const state = this.panel
        const terminalTab = _terminal ?? this.resolveTerminalForSend()
        if (!state?.visible || !terminalTab) {
            if (!terminalTab) {
                this.notifications.info(this.translate.instant('No active terminal'))
            }
            return
        }

        const text = stripComments(this.getTextToSend(state.editor))
        if (!text.trim()) {
            this.notifications.info(this.translate.instant('Nothing to send'))
            return
        }

        this.sendToTerminal(terminalTab, text)
    }

    async sendLinesWithInterval (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.panel
        if (!state?.visible) {
            return
        }

        if (!state.batchStatusBar || !state.sendIntervalInput || !state.sendLoopCountInput) {
            this.notifications.error(this.translate.instant('Loop send failed'))
            console.warn('[CommandEditorPanel] Panel UI outdated — close and reopen the panel (Ctrl+E)')
            return
        }

        const terminalTab = _terminal ?? this.resolveTerminalForSend()
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
        const state = this.panel
        if (!state?.visible || state.batchStatusBar.style.display !== 'flex') {
            return
        }

        this.cancelBatchSend()
    }

    private startLoopSendJob (
        state: PanelState,
        terminal: BaseTerminalTabComponent<any>,
        lines: string[],
        delayMs: number,
        loopCount: number,
    ): void {
        const jobId = ++this.batchSendJobId

        this.showBatchStatus(state, lines, 0, 0, loopCount)
        state.editor.layout()

        let sentCount = 0

        const finish = (): void => {
            if (jobId !== this.batchSendJobId) {
                return
            }
            this.hideBatchStatus(state)
            state.editor.layout()
            if (sentCount > 0) {
                this.notifications.notice(`${this.translate.instant('Lines sent')} (${sentCount})`)
            } else {
                this.notifications.error(this.translate.instant('Loop send failed'))
                console.error('[CommandEditorPanel] Loop send finished without sending any line')
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
            if (jobId !== this.batchSendJobId) {
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

            const activeTerminal = this.isTerminalTabAlive(terminal) ? terminal : this.resolveTerminalForSend()
            if (!activeTerminal?.session) {
                this.cancelBatchSend()
                this.notifications.info(this.translate.instant('No active terminal'))
                console.error('[CommandEditorPanel] Loop send stopped: terminal gone at round', round + 1, 'line', lineIndex + 1)
                return
            }

            this.updateBatchStatus(state, lines, lineIndex, round, loopCount)

            try {
                this.sendLineToTerminal(activeTerminal, lines[lineIndex])
                sentCount++
                console.error(
                    '[CommandEditorPanel] Loop send',
                    `round ${round + 1}/${loopCount}`,
                    `line ${lineIndex + 1}/${lines.length}`,
                    lines[lineIndex],
                )
            } catch (err) {
                console.error('[CommandEditorPanel] Loop send failed:', err)
                this.cancelBatchSend()
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

    private cancelBatchSend (): void {
        this.batchSendJobId++
        if (this.panel) {
            this.hideBatchStatus(this.panel)
            this.panel.editor.layout()
        }
    }

    closeFile (): void {
        const state = this.panel
        if (!state) {
            return
        }

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
        if (this.panel && !this.panel.batchStatusPreview) {
            this.panel.root.remove()
            this.panel = null
        }

        if (this.panel && !this.panel.sendLoopCountInput) {
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
        loopSendBtn.title = 'F6/F7'

        const sendBtn = mkBtn('Send', true)
        sendBtn.title = 'F8/Enter'

        sendGroup.append(intervalWrap, loopCountWrap, loopSendBtn, sendBtn)
        toolbar.append(openBtn, saveBtn, closeBtn, fileLabel, sendGroup)

        const batchStatusBar = document.createElement('div')
        batchStatusBar.className = 'command-editor-panel-batch-status'

        const batchStatusHeader = document.createElement('div')
        batchStatusHeader.className = 'command-editor-panel-batch-status-header'

        const batchStatusLabel = document.createElement('span')
        batchStatusLabel.className = 'command-editor-panel-batch-status-label'

        const batchStatusCloseBtn = document.createElement('button')
        batchStatusCloseBtn.type = 'button'
        batchStatusCloseBtn.className = 'command-editor-panel-batch-status-close btn btn-sm btn-outline-secondary'
        batchStatusCloseBtn.textContent = '×'
        batchStatusCloseBtn.title = 'F7'

        batchStatusHeader.append(batchStatusLabel, batchStatusCloseBtn)

        const batchStatusPreview = document.createElement('div')
        batchStatusPreview.className = 'command-editor-panel-batch-status-preview'

        batchStatusBar.append(batchStatusHeader, batchStatusPreview)

        const editorHost = document.createElement('div')
        editorHost.className = 'command-editor-panel-editor-host'

        root.append(resizeHandle, toolbar, batchStatusBar, editorHost)

        const editor = monaco.editor.create(editorHost, {
            value: '',
            language: COMMAND_EDITOR_LANGUAGE,
            theme: this.getEditorTheme(),
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: false,
            wordWrap: 'on',
            lineNumbers: 'on',
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
        batchStatusCloseBtn.addEventListener('mousedown', (event: MouseEvent) => {
            event.preventDefault()
        })
        batchStatusCloseBtn.addEventListener('click', () => this.cancelLoopSend())
        sendIntervalInput.addEventListener('change', () => this.persistSendIntervalInput(sendIntervalInput))
        sendIntervalInput.addEventListener('wheel', (event: WheelEvent) => {
            event.preventDefault()
            this.adjustIntervalInput(sendIntervalInput, event.deltaY < 0 ? SEND_INTERVAL_STEP_SEC : -SEND_INTERVAL_STEP_SEC)
        }, { passive: false })
        sendLoopCountInput.addEventListener('change', () => this.persistSendLoopCountInput(sendLoopCountInput))

        this.setupEditorKeybindings(editor, root)

        editor.onDidChangeCursorSelection((event) => {
            this.savedEditorSelection = event.selection
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
            batchStatusBar,
            batchStatusHeader,
            batchStatusLabel,
            batchStatusPreview,
            batchStatusCloseBtn,
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
        this.cancelBatchSend()
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

            if (this.targetTerminalTab && !this.isTerminalTabAlive(this.targetTerminalTab)) {
                this.cancelBatchSend()
                this.targetTerminalTab = this.getActiveTerminalTab()
            }

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
        mountRoot: HTMLElement,
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
        const editorContext = 'editorTextFocus && !findWidgetVisible && !suggestWidgetVisible'

        editor.addCommand(monaco.KeyCode.Enter, send, editorContext)
        editor.addCommand(monaco.KeyCode.F8, send, editorContext)
        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, insertNewline, editorContext)
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
            monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyA,
            () => editor.trigger('keyboard', 'editor.action.blockComment', null),
            editorContext,
        )
        editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ,
            () => showHeadingOutlinePicker(editor, mountRoot),
            editorContext,
        )
    }

    private registerEditorLanguageFeatures (): void {
        if (CommandEditorPanelService.languageFeaturesRegistered) {
            return
        }
        CommandEditorPanelService.languageFeaturesRegistered = true

        registerCommandEditorLanguage()
        registerMarkdownHeadingFeatures()
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

            #${BAR_ID} .command-editor-panel-batch-status {
                display: none;
                flex: none;
                flex-direction: column;
                align-items: stretch;
                gap: 4px;
                padding: 6px 8px;
                font-size: 12px;
                color: var(--bs-secondary-color, #ccc);
                background: rgba(47, 140, 255, 0.12);
                border-bottom: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.12));
            }

            #${BAR_ID} .command-editor-panel-batch-status.active {
                display: flex;
            }

            #${BAR_ID} .command-editor-panel-batch-status-header {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: none;
            }

            #${BAR_ID} .command-editor-panel-batch-status-label {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-family: monospace;
            }

            #${BAR_ID} .command-editor-panel-batch-status-preview {
                margin: 0;
                max-height: 120px;
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

            #${BAR_ID} .command-editor-panel-batch-status-preview .batch-line-current {
                color: var(--bs-primary, #4da3ff);
                font-weight: 600;
            }

            #${BAR_ID} .command-editor-panel-batch-status-close {
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
                width: 12px;
                font-size: 10px;
                color: var(--bs-secondary-color, #888);
                text-align: center;
                user-select: none;
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
        `
        document.head.appendChild(style)
    }

    private getTextToSend (editor: monaco.editor.IStandaloneCodeEditor): string {
        const selection = editor.getSelection()
        const model = editor.getModel()
        if (!model) {
            return ''
        }

        if (selection && !selection.isEmpty()) {
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

    private renderBatchPreview (state: PanelState, lines: string[], currentIndex: number): void {
        state.batchStatusPreview.replaceChildren()
        for (let index = 0; index < lines.length; index++) {
            const lineEl = document.createElement('div')
            lineEl.className = index === currentIndex ? 'batch-line-current' : 'batch-line'
            lineEl.textContent = lines[index]
            state.batchStatusPreview.append(lineEl)
        }
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

    private showBatchStatus (
        state: PanelState,
        lines: string[],
        lineIndex: number,
        round: number,
        loopCount: number,
    ): void {
        state.batchStatusLabel.textContent = this.formatBatchStatusLabel(round, loopCount, lineIndex, lines.length)
        this.renderBatchPreview(state, lines, lineIndex)
        state.batchStatusBar.classList.add('active')
        state.batchStatusBar.style.display = 'flex'
        state.loopSendBtn.disabled = true
    }

    private updateBatchStatus (
        state: PanelState,
        lines: string[],
        lineIndex: number,
        round: number,
        loopCount: number,
    ): void {
        state.batchStatusLabel.textContent = this.formatBatchStatusLabel(round, loopCount, lineIndex, lines.length)
        this.renderBatchPreview(state, lines, lineIndex)
    }

    private hideBatchStatus (state: PanelState): void {
        state.batchStatusBar.classList.remove('active')
        state.batchStatusBar.style.display = 'none'
        state.batchStatusLabel.textContent = ''
        state.batchStatusPreview.replaceChildren()
        state.loopSendBtn.disabled = false
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
        if (this.targetTerminalTab && this.isTerminalTabAlive(this.targetTerminalTab)) {
            return this.targetTerminalTab
        }

        this.targetTerminalTab = this.getActiveTerminalTab()
        return this.targetTerminalTab
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
