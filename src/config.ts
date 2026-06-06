import { ConfigProvider, Platform } from 'tabby-core'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            panelPosition: 'right',
            panelSize: null as number | null,
            lastOpenedFile: null as string | null,
        },
        hotkeys: {
            'toggle-command-editor-panel': [],
            'find-in-command-editor': [],
            'open-command-editor-file': [],
            'save-command-editor-file': [],
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
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
            },
        },
    }
}
