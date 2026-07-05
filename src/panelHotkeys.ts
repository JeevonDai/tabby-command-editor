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
        this.hotkeys.hotkey$.subscribe(async hotkey => {
            switch (hotkey) {
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
                case 'open-command-editor-symbol':
                    this.panelService.openSymbolPicker()
                    break
            }
        })
    }
}
