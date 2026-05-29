import { Injectable } from '@angular/core'
import { TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent, TerminalContextMenuItemProvider } from 'tabby-terminal'
import { CommandEditorPanelService } from './services/commandEditorPanel.service'

@Injectable()
export class CommandEditorContextMenuProvider extends TerminalContextMenuItemProvider {
    weight = 50

    constructor (
        private panelService: CommandEditorPanelService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems (tab: BaseTerminalTabComponent<any>): Promise<import('tabby-core').MenuItemOptions[]> {
        const visible = this.panelService.isOverlayVisible(tab)
        return [{
            label: visible
                ? this.translate.instant('Close command editor panel')
                : this.translate.instant('Open command editor panel'),
            click: () => this.panelService.togglePanel(tab),
        }]
    }
}
