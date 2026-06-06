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
                case 'toggle-command-editor-panel':
                    await this.panelService.togglePanel()
                    break
                case 'find-in-command-editor':
                    await this.panelService.openFindWidget()
                    break
                case 'open-command-editor-file':
                    await this.panelService.openFile()
                    break
                case 'save-command-editor-file':
                    await this.panelService.saveFile()
                    break
            }
        })
    }
}
