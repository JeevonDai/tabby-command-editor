import { Injectable } from '@angular/core'
import { AppService, ConfigService, NotificationsService, PlatformService, SplitTabComponent, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

const STYLE_ID = 'tabby-command-editor-panel-style'
const BAR_ID = 'tabby-command-editor-panel-bar'
const BODY_CLASS = 'tabby-command-editor-panel-enabled'
const BROADCAST_BAR_ID = 'tabby-broadcast-input-bar'
const TAB_CONTENT_SELECTOR = 'app-root > .content > .content'

type PanelPosition = 'bottom' | 'right'

interface PanelState {
    root: HTMLElement
    editorHost: HTMLElement
    editor: monaco.editor.IStandaloneCodeEditor
    fileLabel: HTMLElement
    filePath: string | null
    visible: boolean
    layoutAdjusted: boolean
}

@Injectable()
export class CommandEditorPanelService {
    private panel: PanelState | null = null
    private readonly onWindowResize = (): void => {
        if (!this.panel?.visible) {
            return
        }
        this.applyPanelPosition(this.panel)
        this.adjustLayout(this.panel)
        this.panel.editor.layout()
    }

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) {
        this.app.ready$.subscribe(() => {
            this.restoreLastOpenedFile()
        })
    }

    disposeOverlay (_tab: BaseTerminalTabComponent<any>): void {
        // Global panel — nothing to dispose per terminal tab
    }

    isOverlayVisible (_tab: BaseTerminalTabComponent<any>): boolean {
        return this.panel?.visible ?? false
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
        const state = this.panel
        if (!state) {
            return
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
        toolbar.append(openBtn, saveBtn, closeBtn, fileLabel, sendBtn)

        const editorHost = document.createElement('div')
        editorHost.className = 'command-editor-panel-editor-host'

        root.append(toolbar, editorHost)

        const editor = monaco.editor.create(editorHost, {
            value: '',
            language: 'shell',
            theme: this.getEditorTheme(),
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'on',
            lineNumbers: 'on',
            fontSize: 14,
            fontFamily: 'monospace',
            tabSize: 2,
            insertSpaces: true,
            quickSuggestions: false,
        })

        openBtn.addEventListener('click', () => this.openFile())
        saveBtn.addEventListener('click', () => this.saveFile())
        closeBtn.addEventListener('click', () => this.closeFile())
        sendBtn.addEventListener('click', () => this.sendFromPanel())

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => this.sendFromPanel())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, () => this.openFile())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.saveFile())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, () => {
            this.pasteIntoEditor(editor)
        })

        this.panel = { root, editorHost, editor, fileLabel, filePath: null, visible: false, layoutAdjusted: false }
        return this.panel
    }

    private restoreLastOpenedFile (): void {
        const filePath = this.config.store.commandEditor?.lastOpenedFile
        if (!filePath) {
            return
        }

        try {
            const state = this.ensurePanel()
            if (!this.loadFileFromPath(state, filePath)) {
                this.config.store.commandEditor.lastOpenedFile = null
                this.config.save()
            }
        } catch (err) {
            console.error('[CommandEditorPanel] Failed to restore last opened file:', err)
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

    private showPanel (state: PanelState): void {
        this.mountPanel(state.root)
        this.applyPanelPosition(state)
        state.root.style.display = 'flex'
        state.visible = true
        document.body.classList.add(BODY_CLASS)
        document.body.dataset.commandEditorPanelPosition = this.getPanelPosition()
        window.addEventListener('resize', this.onWindowResize)

        requestAnimationFrame(() => {
            this.adjustLayout(state)
            state.editor.layout()
            state.editor.focus()
        })
    }

    private hidePanel (state: PanelState): void {
        state.root.style.display = 'none'
        state.visible = false
        state.root.remove()
        document.body.classList.remove(BODY_CLASS)
        delete document.body.dataset.commandEditorPanelPosition
        window.removeEventListener('resize', this.onWindowResize)
        this.restoreLayout(state)
    }

    /** Shrink the terminal tab area while the panel is visible */
    private adjustLayout (state: PanelState): void {
        const host = this.getTabContentArea()
        if (!host) {
            window.dispatchEvent(new Event('resize'))
            return
        }

        const broadcastHeight = this.getBroadcastBarHeight()
        const position = this.getPanelPosition()

        host.style.boxSizing = 'border-box'
        state.layoutAdjusted = true

        if (position === 'right') {
            const panelWidth = state.root.offsetWidth || Math.round(host.clientWidth * 0.38)
            host.style.paddingRight = `${panelWidth}px`
            host.style.paddingBottom = broadcastHeight > 0 ? `${broadcastHeight}px` : ''
        } else {
            host.style.paddingRight = ''
            const panelHeight = state.root.offsetHeight || Math.round(host.clientHeight * 0.38)
            host.style.paddingBottom = `${panelHeight + broadcastHeight}px`
        }

        window.dispatchEvent(new Event('resize'))
    }

    private restoreLayout (state: PanelState): void {
        if (!state.layoutAdjusted) {
            return
        }

        const host = this.getTabContentArea()
        if (host) {
            host.style.paddingRight = ''
            host.style.paddingBottom = ''
            host.style.boxSizing = ''
        }

        state.layoutAdjusted = false
        window.dispatchEvent(new Event('resize'))
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
            #${BAR_ID} {
                position: absolute;
                z-index: 100;
                display: flex;
                flex-direction: column;
                background: var(--bs-body-bg, rgba(16, 18, 22, 0.96));
                backdrop-filter: blur(6px);
                box-shadow: 0 0 12px rgba(0, 0, 0, 0.35);
            }

            #${BAR_ID}.position-bottom {
                left: 0;
                right: 0;
                height: 38%;
                min-height: 140px;
                max-height: 70%;
                border-top: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
            }

            #${BAR_ID}.position-right {
                top: 0;
                right: 0;
                width: 38%;
                min-width: 320px;
                max-width: 60%;
                border-left: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.15));
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

    private pasteIntoEditor (editor: monaco.editor.IStandaloneCodeEditor): void {
        const text = this.platform.readClipboard()
        if (!text) {
            return
        }
        const selection = editor.getSelection()
        if (selection) {
            editor.executeEdits('paste', [{ range: selection, text, forceMoveMarkers: true }])
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
