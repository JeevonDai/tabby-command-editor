import { ConfigProvider, Platform } from 'tabby-core'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            panelPosition: 'right',
            panelSize: null as number | null,
            lastOpenedFile: null as string | null,
            /** Seconds to wait after each line when batch-sending (e.g. 0.05 = 50ms). */
            sendLineIntervalSec: 1,
        },
        hotkeys: {
            'toggle-command-editor-panel': [],
            'find-in-command-editor': [],
            'open-command-editor-file': [],
            'save-command-editor-file': [],
            'reload-command-editor-file': [],
            'send-command-editor-lines': [],
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
                'send-command-editor-lines': ['F6'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F6'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F6'],
            },
        },
    }
}
