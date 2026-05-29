import { ConfigProvider, Platform } from 'tabby-core'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            executeImmediately: true,
            panelPosition: 'bottom',
            panelSendExecuteImmediately: true,
        },
        hotkeys: {
            'open-command-editor': [],
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
                'open-command-editor': ['Ctrl-E'],
                'toggle-command-editor-panel': ['Ctrl-Alt-E'],
                'send-command-line': ['Ctrl-Enter'],
                'open-command-editor-file': ['Ctrl-O'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'open-command-editor': ['Ctrl-E'],
                'toggle-command-editor-panel': ['Ctrl-Alt-E'],
                'send-command-line': ['Ctrl-Enter'],
                'open-command-editor-file': ['Ctrl-O'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'open-command-editor': ['Ctrl-E'],
                'toggle-command-editor-panel': ['Ctrl-Alt-E'],
                'send-command-line': ['Ctrl-Enter'],
                'open-command-editor-file': ['Ctrl-O'],
            },
        },
    }
}
