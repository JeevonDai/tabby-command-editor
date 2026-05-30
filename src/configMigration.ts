import { Injectable } from '@angular/core'
import { AppService, ConfigService } from 'tabby-core'

/** Remove deprecated config keys from older plugin versions. */
@Injectable()
export class CommandEditorConfigMigration {
    constructor (
        private app: AppService,
        private config: ConfigService,
    ) {
        this.app.ready$.subscribe(() => this.migrate())
    }

    private migrate (): void {
        let changed = false

        const hotkeys = this.config.store.hotkeys as Record<string, string[] | undefined> | undefined
        if (hotkeys?.['open-command-editor']) {
            const legacyBindings = hotkeys['open-command-editor']
            delete hotkeys['open-command-editor']
            changed = true

            const toggleBindings = hotkeys['toggle-command-editor-panel']
            if (legacyBindings?.length && (!toggleBindings || toggleBindings.length === 0)) {
                hotkeys['toggle-command-editor-panel'] = legacyBindings
                changed = true
            }
        }

        const commandEditor = this.config.store.commandEditor as Record<string, unknown> | undefined
        if (commandEditor && 'executeImmediately' in commandEditor) {
            delete commandEditor.executeImmediately
            changed = true
        }

        if (changed) {
            void this.config.save()
        }
    }
}
