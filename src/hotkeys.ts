import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider, TranslateService } from 'tabby-core'

@Injectable()
export class CommandEditorHotkeyProvider extends HotkeyProvider {
    hotkeys: HotkeyDescription[] = [
        {
            id: 'toggle-command-editor-panel',
            name: this.translate.instant('Toggle command editor panel'),
        },
        {
            id: 'find-in-command-editor',
            name: this.translate.instant('Find in command editor'),
        },
        {
            id: 'open-command-editor-file',
            name: this.translate.instant('Open file in command editor'),
        },
        {
            id: 'save-command-editor-file',
            name: this.translate.instant('Save file in command editor'),
        },
    ]

    constructor (private translate: TranslateService) { super() }

    async provide (): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }
}
