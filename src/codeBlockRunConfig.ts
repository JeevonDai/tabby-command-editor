/** User-configurable interpreter identifier (for example python, node or ruby). */
export type ScriptLanguage = string
export type BlockRunMode = 'terminal' | 'background'

export type ScriptLanguageMap = Record<string, string>

export interface CodeBlockRunSettings {
    languageAliases: Record<string, ScriptLanguage>
    terminalCommands: ScriptLanguageMap
    backgroundCommands: ScriptLanguageMap
}

export interface CommandEditorCodeBlockConfig {
    codeBlockLanguageAliases?: Record<string, string>
    codeBlockTerminalCommands?: Record<string, string>
    codeBlockBackgroundCommands?: Record<string, string>
    /** Legacy config key kept for migration. */
    codeBlockTerminalFileCommands?: Record<string, string>
    /** Legacy config key kept for migration. */
    codeBlockBackgroundRunners?: Record<string, string>
}

export const DEFAULT_CODE_BLOCK_LANGUAGE_ALIASES: Record<string, ScriptLanguage> = {
    python: 'python',
    py: 'python',
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
    powershell: 'powershell',
    pwsh: 'powershell',
    ps1: 'powershell',
}

export const DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_UNIX: ScriptLanguageMap = {
    python: 'python {file}',
    bash: 'bash {file}',
    powershell: 'pwsh -NoProfile -ExecutionPolicy Bypass -File {file}',
}

export const DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_WINDOWS: ScriptLanguageMap = {
    python: 'python {file}',
    bash: 'wsl bash {file}',
    powershell: 'powershell -NoProfile -ExecutionPolicy Bypass -File {file}',
}

export const DEFAULT_CODE_BLOCK_BACKGROUND_COMMANDS_UNIX: ScriptLanguageMap = {
    python: 'python -u -',
    bash: 'bash -s',
    powershell: 'pwsh -NoProfile -NonInteractive -Command -',
}

export const DEFAULT_CODE_BLOCK_BACKGROUND_COMMANDS_WINDOWS: ScriptLanguageMap = {
    python: 'python -u -',
    bash: 'wsl bash -s',
    powershell: 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -',
}

export function resolveCodeBlockRunSettings (
    config: CommandEditorCodeBlockConfig | Record<string, unknown> | undefined,
): CodeBlockRunSettings {
    const defaults = getPlatformDefaults()
    const raw = (config ?? {}) as CommandEditorCodeBlockConfig

    return {
        languageAliases: normalizeLanguageAliases(raw.codeBlockLanguageAliases),
        terminalCommands: {
            ...defaults.terminalCommands,
            ...normalizeCommandMap(raw.codeBlockTerminalFileCommands),
            ...normalizeCommandMap(raw.codeBlockTerminalCommands),
        },
        backgroundCommands: {
            ...defaults.backgroundCommands,
            ...normalizeCommandMap(raw.codeBlockBackgroundRunners),
            ...normalizeCommandMap(raw.codeBlockBackgroundCommands),
        },
    }
}

export function formatCodeBlockRunConfigForDisplay (
    config: CommandEditorCodeBlockConfig | Record<string, unknown> | undefined,
): string {
    const settings = resolveCodeBlockRunSettings(config)
    return JSON.stringify({
        codeBlockLanguageAliases: settings.languageAliases,
        codeBlockTerminalCommands: settings.terminalCommands,
        codeBlockBackgroundCommands: settings.backgroundCommands,
    }, null, 2)
}

export function parseCommandLine (commandLine: string): { command: string; args: string[] } {
    const tokens: string[] = []
    let current = ''
    let quote: '"' | '\'' | null = null
    let escaping = false

    for (const char of commandLine.trim()) {
        if (escaping) {
            current += char
            escaping = false
            continue
        }

        if (char === '\\' && quote !== '\'') {
            escaping = true
            continue
        }

        if ((char === '"' || char === '\'') && (!quote || quote === char)) {
            quote = quote ? null : char
            continue
        }

        if (/\s/.test(char) && !quote) {
            if (current) {
                tokens.push(current)
                current = ''
            }
            continue
        }

        current += char
    }

    if (escaping) {
        current += '\\'
    }
    if (current) {
        tokens.push(current)
    }

    const [command = '', ...args] = tokens
    return { command, args }
}

function getPlatformDefaults (): { terminalCommands: ScriptLanguageMap; backgroundCommands: ScriptLanguageMap } {
    if (process.platform === 'win32') {
        return {
            terminalCommands: DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_WINDOWS,
            backgroundCommands: DEFAULT_CODE_BLOCK_BACKGROUND_COMMANDS_WINDOWS,
        }
    }

    return {
        terminalCommands: DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_UNIX,
        backgroundCommands: DEFAULT_CODE_BLOCK_BACKGROUND_COMMANDS_UNIX,
    }
}

function normalizeLanguageAliases (
    aliases: Record<string, string> | undefined,
): Record<string, ScriptLanguage> {
    const normalized = { ...DEFAULT_CODE_BLOCK_LANGUAGE_ALIASES }
    for (const [tag, language] of Object.entries(aliases ?? {})) {
        const normalizedTag = tag.trim().toLowerCase()
        const normalizedLanguage = normalizeLanguageName(language)
        if (normalizedTag && normalizedLanguage) {
            normalized[normalizedTag] = normalizedLanguage
        }
    }
    return normalized
}

function normalizeCommandMap (
    commands: Record<string, string> | undefined,
): ScriptLanguageMap {
    const normalized: ScriptLanguageMap = {}
    for (const [rawLanguage, command] of Object.entries(commands ?? {})) {
        const language = normalizeLanguageName(rawLanguage)
        if (typeof command === 'string' && command.trim()) {
            if (language) {
                normalized[language] = command.trim()
            }
        }
    }
    return normalized
}

function normalizeLanguageName (value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
}
