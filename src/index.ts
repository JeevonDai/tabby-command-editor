import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { ConfigProvider, HotkeyProvider } from 'tabby-core'
import { TerminalContextMenuItemProvider } from 'tabby-terminal'
import { SettingsTabProvider } from 'tabby-settings'

import { CommandEditorConfigProvider } from './config'
import { CommandEditorConfigMigration } from './configMigration'
import { CommandEditorLocaleService } from './locale'
import { CommandEditorHotkeyProvider } from './hotkeys'
import { CommandEditorPanelHotkeyHandler } from './panelHotkeys'
import { CommandEditorContextMenuProvider } from './contextMenu'
import { CommandEditorPanelService } from './services/commandEditorPanel.service'
import { CommandEditorSettingsTabComponent, CommandEditorSettingsTabProvider } from './settings'

@NgModule({
    imports: [
        CommonModule,
    ],
    declarations: [
        CommandEditorSettingsTabComponent,
    ],
    providers: [
        CommandEditorPanelService,
        CommandEditorConfigMigration,
        CommandEditorLocaleService,
        CommandEditorPanelHotkeyHandler,
        { provide: ConfigProvider, useClass: CommandEditorConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: CommandEditorHotkeyProvider, multi: true },
        { provide: TerminalContextMenuItemProvider, useClass: CommandEditorContextMenuProvider, multi: true },
        { provide: SettingsTabProvider, useClass: CommandEditorSettingsTabProvider, multi: true },
    ],
})
export default class CommandEditorModule {
    /** Force-init services that subscribe to global hotkeys */
    constructor (
        _panelHotkeys: CommandEditorPanelHotkeyHandler,
        _configMigration: CommandEditorConfigMigration,
        _locale: CommandEditorLocaleService,
    ) {}
}

export { CommandEditorPanelService }
