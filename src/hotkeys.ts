import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider, LocaleService, TranslateService } from 'tabby-core'
import { t } from './locale'

@Injectable()
export class CommandEditorHotkeyProvider extends HotkeyProvider {
    constructor (
        private translate: TranslateService,
        private locale: LocaleService,
    ) { super() }

    async provide (): Promise<HotkeyDescription[]> {
        return [
            {
                id: 'toggle-command-editor-panel',
                name: t(this.translate, this.locale, 'Toggle command editor panel'),
            },
            {
                id: 'find-in-command-editor',
                name: t(this.translate, this.locale, 'Find in command editor'),
            },
            {
                id: 'open-command-editor-file',
                name: t(this.translate, this.locale, 'Open file in command editor'),
            },
            {
                id: 'save-command-editor-file',
                name: t(this.translate, this.locale, 'Save file in command editor'),
            },
            {
                id: 'reload-command-editor-file',
                name: t(this.translate, this.locale, 'Reload file in command editor'),
            },
            {
                id: 'send-command-editor-lines',
                name: t(this.translate, this.locale, 'Send or loop in command editor'),
            },
            {
                id: 'cancel-command-editor-loop',
                name: t(this.translate, this.locale, 'Stop command editor loop'),
            },
            {
                id: 'send-command-editor-panel',
                name: t(this.translate, this.locale, 'Send from command editor'),
            },
            {
                id: 'open-command-editor-outline',
                name: t(this.translate, this.locale, 'Open markdown outline in command editor'),
            },
            {
                id: 'open-command-editor-symbol',
                name: t(this.translate, this.locale, 'Go to symbol in command editor'),
            },
        ]
    }
}
