import { Injectable } from '@angular/core'
import { HotkeysService } from 'tabby-core'
import { CommandEditorPanelService } from './services/commandEditorPanel.service'

@Injectable()
export class CommandEditorPanelHotkeyHandler {
    constructor (
        private hotkeys: HotkeysService,
        private panelService: CommandEditorPanelService,
    ) {
        // Ctrl+E / Ctrl+F / Ctrl+O / Ctrl+S / Ctrl+Q are handled in capture phase
        // (CommandEditorPanelService.onPanelHotkeyCapture) so they never leak to xterm.
        // Keep the standard Tabby handlers as a fallback for events that do not
        // travel through the same document capture path.
        this.hotkeys.hotkey$.subscribe(async hotkey => {
            switch (hotkey) {
                case 'toggle-command-editor-panel':
                    await this.panelService.togglePanel()
                    break
                case 'find-in-command-editor':
                    this.panelService.openFindWidget()
                    break
                case 'open-command-editor-file':
                    await this.panelService.openFile()
                    break
                case 'save-command-editor-file':
                    await this.panelService.saveFile()
                    break
                case 'reload-command-editor-file':
                    await this.panelService.reloadFile()
                    break
                case 'send-command-editor-lines':
                    await this.panelService.loopOrRun()
                    break
                case 'send-command-editor-panel':
                    this.panelService.sendFromPanel()
                    break
                case 'cancel-command-editor-loop':
                    this.panelService.cancelLoopSend()
                    break
                case 'open-command-editor-outline':
                    this.panelService.openOutlinePicker()
                    break
                case 'open-command-editor-symbol':
                    this.panelService.openSymbolPicker()
                    break
            }
        })
    }
}
