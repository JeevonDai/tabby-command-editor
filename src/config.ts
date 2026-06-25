import { ConfigProvider, Platform } from 'tabby-core'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            panelPosition: 'right',
            panelSize: null as number | null,
            lastOpenedFile: null as string | null,
            /** Seconds to wait after each line when batch-sending (e.g. 0.05 = 50ms). */
            sendLineIntervalSec: 1,
            /** How many times to repeat the selected lines in loop send. */
            sendLoopCount: 1,
            /** Whether Python stderr logs are shown as notifications or appended to a file. */
            pythonLogMode: 'notification' as 'notification' | 'file',
        },
        hotkeys: {
            'toggle-command-editor-panel': [],
            'find-in-command-editor': [],
            'open-command-editor-file': [],
            'save-command-editor-file': [],
            'reload-command-editor-file': [],
            'send-command-editor-lines': [],
            'cancel-command-editor-loop': [],
            'open-command-editor-outline': [],
            'open-command-editor-symbol': [],
            'run-command-editor-python': [],
            'toggle-command-editor-python-log': [],
            'open-command-editor-python-log': [],
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
                'send-command-editor-lines': ['F7'],
                'cancel-command-editor-loop': [],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
                'run-command-editor-python': ['F9'],
                'toggle-command-editor-python-log': ['F10'],
                'open-command-editor-python-log': ['Alt-Shift-G'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F7'],
                'cancel-command-editor-loop': [],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
                'run-command-editor-python': ['F9'],
                'toggle-command-editor-python-log': ['F10'],
                'open-command-editor-python-log': ['Alt-Shift-G'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F7'],
                'cancel-command-editor-loop': [],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
                'run-command-editor-python': ['F9'],
                'toggle-command-editor-python-log': ['F10'],
                'open-command-editor-python-log': ['Alt-Shift-G'],
            },
        },
    }
}
