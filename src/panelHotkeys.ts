import { Injectable } from '@angular/core'
import { HotkeysService } from 'tabby-core'
import { CommandEditorPanelService } from './services/commandEditorPanel.service'

@Injectable()
export class CommandEditorPanelHotkeyHandler {
    constructor (
        private hotkeys: HotkeysService,
        private panelService: CommandEditorPanelService,
    ) {
        this.hotkeys.hotkey$.subscribe(async hotkey => {
            switch (hotkey) {
                case 'find-in-command-editor':
                    await this.panelService.openFindWidget()
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
                    await this.panelService.sendLinesWithInterval()
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
