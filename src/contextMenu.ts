import { Injectable } from '@angular/core'
import { LocaleService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent, TerminalContextMenuItemProvider } from 'tabby-terminal'
import { t } from './locale'
import { CommandEditorPanelService } from './services/commandEditorPanel.service'

@Injectable()
export class CommandEditorContextMenuProvider extends TerminalContextMenuItemProvider {
    weight = 50

    constructor (
        private panelService: CommandEditorPanelService,
        private translate: TranslateService,
        private locale: LocaleService,
    ) {
        super()
    }

    async getItems (tab: BaseTerminalTabComponent<any>): Promise<import('tabby-core').MenuItemOptions[]> {
        const visible = this.panelService.isOverlayVisible(tab)
        return [{
            label: visible
                ? t(this.translate, this.locale, 'Close command editor panel')
                : t(this.translate, this.locale, 'Open command editor panel'),
            click: () => this.panelService.togglePanel(tab),
        }]
    }
}
