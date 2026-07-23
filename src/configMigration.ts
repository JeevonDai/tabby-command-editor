import { Injectable } from '@angular/core'
import { AppService, ConfigService } from 'tabby-core'
import { CommandEditorCodeBlockConfig, resolveCodeBlockRunSettings } from './codeBlockRunConfig'

/** Remove deprecated config keys from older plugin versions. */
@Injectable()
export class CommandEditorConfigMigration {
    constructor (
        private app: AppService,
        private config: ConfigService,
    ) {
        // ConfigService.store is not available during Angular provider construction.
        // Config readiness is the authoritative point at which migrations may read it.
        this.config.ready$.subscribe(() => this.migrate())
        this.app.ready$.subscribe(() => this.migrate())
    }

    private migrate (): void {
        if (!this.config.store) {
            return
        }

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

        if (hotkeys?.['send-command-line']) {
            delete hotkeys['send-command-line']
            changed = true
        }

        for (const key of ['pythonLogMode', 'blockRunMode', 'codeBlockBackgroundCommands']) {
            if (commandEditor && key in commandEditor) { delete commandEditor[key]; changed = true }
        }
        for (const key of [
            'toggle-command-editor-python-log',
            'open-command-editor-python-log',
            'bind-command-editor-python-api',
        ]) {
            if (hotkeys?.[key]) { delete hotkeys[key]; changed = true }
        }

        if (hotkeys?.['send-command-editor-lines']?.includes('F7')
            && !hotkeys['send-command-editor-lines']?.includes('F9')) {
            hotkeys['send-command-editor-lines'] = ['F9']
            changed = true
        }

        // Run code block (legacy) is covered by F9 (send-command-editor-lines).
        if (hotkeys?.['run-command-editor-python']) {
            delete hotkeys['run-command-editor-python']
            changed = true
        }


        if (hotkeys && (!hotkeys['cancel-command-editor-loop'] || hotkeys['cancel-command-editor-loop'].length === 0)) {
            hotkeys['cancel-command-editor-loop'] = ['F6']
            changed = true
        }

        const terminalCommands = commandEditor?.['codeBlockTerminalCommands'] as Record<string, unknown> | undefined
        if (terminalCommands && (
            terminalCommands.python === 'python3 {file}'
            || terminalCommands.python === 'py -3 {file}'
        )) {
            terminalCommands.python = 'python {file}'
            changed = true
        }

        if (commandEditor?.['codeBlockTerminalFileCommands'] || commandEditor?.['codeBlockBackgroundRunners']) {
            const resolved = resolveCodeBlockRunSettings(commandEditor as CommandEditorCodeBlockConfig)
            commandEditor.codeBlockTerminalCommands = resolved.terminalCommands
            delete commandEditor.codeBlockTerminalFileCommands
            delete commandEditor.codeBlockBackgroundRunners
            changed = true
        }

        if (hotkeys?.['auto-send-command-editor']?.length) {
            const legacyBindings = hotkeys['auto-send-command-editor']
            delete hotkeys['auto-send-command-editor']
            const sendLines = hotkeys['send-command-editor-lines']
            if (legacyBindings?.length && (!sendLines || sendLines.length === 0)) {
                hotkeys['send-command-editor-lines'] = legacyBindings
            }
            changed = true
        }

        if (changed) {
            void this.config.save()
        }
    }
}
