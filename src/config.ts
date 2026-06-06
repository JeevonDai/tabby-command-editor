import { ConfigProvider, Platform } from 'tabby-core'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            panelPosition: 'right',
            lastOpenedFile: null as string | null,
        },
        hotkeys: {
            'toggle-command-editor-panel': [],
            'send-command-line': [],
            'open-command-editor-file': [],
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
                'send-command-line': ['F8'],
                'open-command-editor-file': ['Ctrl-O'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'send-command-line': ['F8'],
                'open-command-editor-file': ['Ctrl-O'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'send-command-line': ['F8'],
                'open-command-editor-file': ['Ctrl-O'],
            },
        },
    }
}
