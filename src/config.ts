import { ConfigProvider, Platform } from 'tabby-core'
import {
    DEFAULT_CODE_BLOCK_LANGUAGE_ALIASES,
    DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_UNIX,
    DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_WINDOWS,
} from './codeBlockRunConfig'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            panelPosition: 'right',
            panelSize: null as number | null,
            lastOpenedFile: null as string | null,
            openedFileHistory: [] as string[],
            /** Seconds to wait after each line when batch-sending (e.g. 0.05 = 50ms). */
            sendLineIntervalSec: 1,
            /** Display unit for the send-line interval control. */
            sendLineIntervalUnit: 's' as 'min' | 's' | 'ms',
            /** How many times to repeat the selected lines in loop send. */
            sendLoopCount: 1,
            /** When true, right-click sends the line under the cursor instead of opening the context menu. */
            rightClickSendLine: false,
            /** Markdown fence language tag → interpreter family (python/bash/powershell). */
            codeBlockLanguageAliases: { ...DEFAULT_CODE_BLOCK_LANGUAGE_ALIASES },
            /** One terminal command per interpreter; `{file}` = temp script path. */
            codeBlockTerminalCommands: { ...DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_UNIX },
        },
        hotkeys: {
            'toggle-command-editor-panel': [],
            'find-in-command-editor': [],
            'open-command-editor-file': [],
            'save-command-editor-file': [],
            'reload-command-editor-file': [],
            'send-command-editor-lines': [],
            'cancel-command-editor-loop': [],
            'send-command-editor-panel': [],
            'open-command-editor-outline': [],
            'open-command-editor-symbol': [],
            'command-tips': {
                __nonStructural: true,
                toggle: [],
                'clear-profile': [],
            },
            'history-autocomplete': {
                toggle: [],
            },
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F9'],
                'cancel-command-editor-loop': ['F6'],
                'send-command-editor-panel': ['F8'],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
            },
        },
        [Platform.Windows]: {
            commandEditor: {
                codeBlockTerminalCommands: { ...DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_WINDOWS },
            },
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F9'],
                'cancel-command-editor-loop': ['F6'],
                'send-command-editor-panel': ['F8'],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F9'],
                'cancel-command-editor-loop': ['F6'],
                'send-command-editor-panel': ['F8'],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
            },
        },
    }
}
