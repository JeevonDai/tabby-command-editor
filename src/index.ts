import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ToastrModule } from 'ngx-toastr'
import { ConfigProvider, HotkeyProvider } from 'tabby-core'
import { TerminalDecorator, TerminalContextMenuItemProvider } from 'tabby-terminal'

import { CommandEditorConfigProvider } from './config'
import { CommandEditorHotkeyProvider } from './hotkeys'
import { CommandEditorDecorator } from './decorator'
import { CommandEditorPanelHotkeyHandler } from './panelHotkeys'
import { CommandEditorContextMenuProvider } from './contextMenu'
import { PowerExtractionService } from './services/powerExtraction.service'
import { CommandEditorPanelService } from './services/commandEditorPanel.service'
import { CommandEditorModalComponent } from './components/commandEditorModal.component'

@NgModule({
    imports: [
        CommonModule,
        NgbModule,
        ToastrModule,
    ],
    providers: [
        PowerExtractionService,
        CommandEditorPanelService,
        CommandEditorPanelHotkeyHandler,
        { provide: ConfigProvider, useClass: CommandEditorConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: CommandEditorHotkeyProvider, multi: true },
        { provide: TerminalDecorator, useClass: CommandEditorDecorator, multi: true },
        { provide: TerminalContextMenuItemProvider, useClass: CommandEditorContextMenuProvider, multi: true },
    ],
    declarations: [
        CommandEditorModalComponent,
    ],
})
export default class CommandEditorModule {
    /** Force-init services that subscribe to global hotkeys */
    constructor (_panelHotkeys: CommandEditorPanelHotkeyHandler) {}
}

export { PowerExtractionService, PowerExtractionResult } from './services/powerExtraction.service'
export { CommandEditorModalComponent }
export { CommandEditorPanelService }
