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
        {
            id: 'reload-command-editor-file',
            name: this.translate.instant('Reload file in command editor'),
        },
        {
            id: 'send-command-editor-lines',
            name: this.translate.instant('Loop or run in command editor'),
        },
        {
            id: 'cancel-command-editor-loop',
            name: this.translate.instant('Stop command editor loop'),
        },
        {
            id: 'open-command-editor-outline',
            name: this.translate.instant('Open markdown outline in command editor'),
        },
        {
            id: 'open-command-editor-symbol',
            name: this.translate.instant('Go to symbol in command editor'),
        },
        {
            id: 'run-command-editor-python',
            name: this.translate.instant('Run code block in command editor'),
        },
        {
            id: 'toggle-command-editor-python-log',
            name: this.translate.instant('Toggle Python log mode in command editor'),
        },
        {
            id: 'open-command-editor-python-log',
            name: this.translate.instant('Open Python log location'),
        },
    ]

    constructor (private translate: TranslateService) { super() }

    async provide (): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }
}
