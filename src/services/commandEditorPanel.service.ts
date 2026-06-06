import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, ConfigService, NotificationsService, PlatformService, SplitTabComponent, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

const STYLE_ID = 'tabby-command-editor-panel-style'
const BAR_ID = 'tabby-command-editor-panel-bar'
const BODY_CLASS = 'tabby-command-editor-panel-enabled'
const BROADCAST_BAR_ID = 'tabby-broadcast-input-bar'
const TAB_CONTENT_SELECTOR = 'app-root > .content > .content'
const PANEL_SIZE_VAR = '--tabby-command-editor-panel-size'
const CONTENT_TAB_SELECTOR = 'app-root .content > .content > .content-tab.content-tab-active, app-root > .content > .content > .content-tab.content-tab-active'

type PanelPosition = 'bottom' | 'right'

interface PanelState {
    root: HTMLElement
    resizeHandle: HTMLElement
    editorHost: HTMLElement
    editor: monaco.editor.IStandaloneCodeEditor
    fileLabel: HTMLElement
    filePath: string | null
    visible: boolean
    panelSizePx: number
}

@Injectable()
export class CommandEditorPanelService {
    private panel: PanelState | null = null
    private pendingLastOpenedFile: string | null = null
    private editorFocused = false
    private layoutAdjusted = false
    private tabAreaObserver: ResizeObserver | null = null
    private activeTabSubscription: Subscription | null = null
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
    ) {
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
            this.showPanel(state)
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
            this.showPanel(state)
        } catch (err) {
            console.error('[CommandEditorPanel] Failed to toggle panel:', err)
            this.notifications.error(this.translate.instant('Failed to open command editor panel'))
        }
    }

    async openFile (_terminal?: BaseTerminalTabComponent<any> | null): Promise<void> {
        const state = this.ensurePanel()
        if (!state.visible) {
            this.showPanel(state)
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
            this.showPanel(state)
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

    sendFromPanel (_terminal?: BaseTerminalTabComponent<any> | null): void {
        const state = this.panel
        const terminalTab = this.getActiveTerminalTab()
        if (!state?.visible || !terminalTab) {
            return
        }

        const text = this.getTextToSend(state.editor)
        if (!text.trim()) {
            this.notifications.info(this.translate.instant('Nothing to send'))
            return
        }

        this.sendToTerminal(terminalTab, text)
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
            monaco.editor.setModelLanguage(model, 'shell')
        }

        if (this.config.store.commandEditor) {
            this.config.store.commandEditor.lastOpenedFile = null
            this.config.save()
        }

        this.updateFileLabel(state)
        state.editor.focus()
    }

    private ensurePanel (): PanelState {
        if (this.panel) {
            return this.panel
        }

        this.installStyles()

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
        const sendBtn = mkBtn('Send line', true)
        sendBtn.title = 'Enter / F8'
        toolbar.append(openBtn, saveBtn, closeBtn, fileLabel, sendBtn)

        const editorHost = document.createElement('div')
        editorHost.className = 'command-editor-panel-editor-host'

        root.append(resizeHandle, toolbar, editorHost)

        const editor = monaco.editor.create(editorHost, {
            value: '',
            language: 'shell',
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

        this.setupEditorKeybindings(editor)

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
            monaco.editor.setModelLanguage(model, this.detectLanguage(filePath))
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

    private showPanel (state: PanelState): void {
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

    private setupEditorKeybindings (editor: monaco.editor.IStandaloneCodeEditor): void {
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
        if (document.getElementById(STYLE_ID)) {
            return
        }

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

            #${BAR_ID} .command-editor-panel-toolbar .btn-primary {
                margin-left: auto;
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

    private sendToTerminal (terminal: BaseTerminalTabComponent<any>, command: string): void {
        let lines = command.replace(/\r\n/g, '\n').split('\n')
        while (lines.length > 1 && lines[lines.length - 1] === '') {
            lines.pop()
        }

        for (const line of lines) {
            terminal.sendInput(line)
            terminal.sendInput('\r')
        }
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
                if (child instanceof BaseTerminalTabComponent) {
                    return child
                }
            }
        }

        return null
    }

    private detectLanguage (filePath: string): string {
        const ext = filePath.split('.').pop()?.toLowerCase()
        const map: Record<string, string> = {
            sh: 'shell',
            bash: 'shell',
            bat: 'bat',
            ps1: 'powershell',
            py: 'python',
            js: 'javascript',
            ts: 'typescript',
            json: 'json',
            yaml: 'yaml',
            yml: 'yaml',
            md: 'markdown',
            ini: 'ini',
            cfg: 'ini',
            conf: 'ini',
        }
        return map[ext ?? ''] ?? 'plaintext'
    }

    private getEditorTheme (): 'vs-dark' | 'vs' {
        const scheme = this.config.store.terminal?.colorScheme
        if (scheme?.background?.startsWith('#')) {
            const bg = scheme.background
            const r = parseInt(bg.slice(1, 3), 16)
            const g = parseInt(bg.slice(3, 5), 16)
            const b = parseInt(bg.slice(5, 7), 16)
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
            return luminance < 0.5 ? 'vs-dark' : 'vs'
        }
        return 'vs-dark'
    }
}
