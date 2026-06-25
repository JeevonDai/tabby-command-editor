import { ConfigProvider, Platform } from 'tabby-core'
import {
    DEFAULT_CODE_BLOCK_BACKGROUND_RUNNERS_UNIX,
    DEFAULT_CODE_BLOCK_BACKGROUND_RUNNERS_WINDOWS,
    DEFAULT_CODE_BLOCK_LANGUAGE_ALIASES,
    DEFAULT_CODE_BLOCK_TERMINAL_FILE_COMMANDS,
} from './codeBlockRunConfig'

const unixBackgroundRunnerRows = Object.fromEntries(
    Object.entries(DEFAULT_CODE_BLOCK_BACKGROUND_RUNNERS_UNIX).map(([lang, runners]) => [
        lang,
        runners.map(runner => [runner.command, ...runner.args]),
    ]),
)

const windowsBackgroundRunnerRows = Object.fromEntries(
    Object.entries(DEFAULT_CODE_BLOCK_BACKGROUND_RUNNERS_WINDOWS).map(([lang, runners]) => [
        lang,
        runners.map(runner => [runner.command, ...runner.args]),
    ]),
)

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            panelPosition: 'right',
            panelSize: null as number | null,
            lastOpenedFile: null as string | null,
            /** Seconds to wait after each line when batch-sending (e.g. 0.05 = 50ms). */
            sendLineIntervalSec: 1,
            /** Display unit for the send-line interval control. */
            sendLineIntervalUnit: 's' as 'min' | 's' | 'ms',
            /** How many times to repeat the selected lines in loop send. */
            sendLoopCount: 1,
            /** How code blocks (python/powershell/bash) are executed. */
            blockRunMode: 'background' as 'terminal' | 'background',
            /** Markdown fence language tag → interpreter family (python/bash/powershell). */
            codeBlockLanguageAliases: { ...DEFAULT_CODE_BLOCK_LANGUAGE_ALIASES },
            /**
             * BG mode spawn commands, tried in order. Each entry is [executable, ...args];
             * use "-" as the last arg to read script from stdin.
             */
            codeBlockBackgroundRunners: unixBackgroundRunnerRows,
            /**
             * TF mode command templates; `{file}` is replaced with the quoted temp script path.
             * Keys under each language match terminal shell kinds (default, wsl, msys, …).
             */
            codeBlockTerminalFileCommands: { ...DEFAULT_CODE_BLOCK_TERMINAL_FILE_COMMANDS },
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
                'send-command-editor-lines': ['F9'],
                'cancel-command-editor-loop': [],
                'send-command-editor-panel': ['F8'],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
                'toggle-command-editor-python-log': ['F10'],
                'open-command-editor-python-log': ['Alt-Shift-G'],
            },
        },
        [Platform.Windows]: {
            commandEditor: {
                codeBlockBackgroundRunners: windowsBackgroundRunnerRows,
            },
            hotkeys: {
                'toggle-command-editor-panel': ['Ctrl-E'],
                'find-in-command-editor': ['Ctrl-F'],
                'open-command-editor-file': ['Ctrl-O'],
                'save-command-editor-file': ['Ctrl-S'],
                'reload-command-editor-file': ['F5'],
                'send-command-editor-lines': ['F9'],
                'cancel-command-editor-loop': [],
                'send-command-editor-panel': ['F8'],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
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
                'send-command-editor-lines': ['F9'],
                'cancel-command-editor-loop': [],
                'send-command-editor-panel': ['F8'],
                'open-command-editor-outline': ['Ctrl-Q'],
                'open-command-editor-symbol': ['Alt-Shift-Enter'],
                'toggle-command-editor-python-log': ['F10'],
                'open-command-editor-python-log': ['Alt-Shift-G'],
            },
        },
    }
}
