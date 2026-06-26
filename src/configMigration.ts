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

        if (hotkeys?.['send-command-line']) {
            delete hotkeys['send-command-line']
            changed = true
        }

        if (commandEditor && 'pythonLogMode' in commandEditor) {
            if (!('blockRunMode' in commandEditor)) {
                commandEditor.blockRunMode = 'background'
            }
            delete commandEditor.pythonLogMode
            changed = true
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

        if (hotkeys && !('toggle-command-editor-python-log' in hotkeys)) {
            hotkeys['toggle-command-editor-python-log'] = ['F10']
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

        const backgroundCommands = commandEditor?.['codeBlockBackgroundCommands'] as Record<string, unknown> | undefined
        if (backgroundCommands && (
            backgroundCommands.python === 'python3 -u -'
            || backgroundCommands.python === 'py -3 -u -'
        )) {
            backgroundCommands.python = 'python -u -'
            changed = true
        }

        if (commandEditor?.['codeBlockTerminalFileCommands'] || commandEditor?.['codeBlockBackgroundRunners']) {
            const resolved = resolveCodeBlockRunSettings(commandEditor as CommandEditorCodeBlockConfig)
            commandEditor.codeBlockTerminalCommands = resolved.terminalCommands
            commandEditor.codeBlockBackgroundCommands = resolved.backgroundCommands
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
