export type ScriptLanguage = 'python' | 'bash' | 'powershell'
export type BlockRunMode = 'terminal' | 'background'

export type ScriptLanguageMap = Record<ScriptLanguage, string>

export interface CodeBlockRunSettings {
    languageAliases: Record<string, ScriptLanguage>
    terminalCommands: ScriptLanguageMap
    backgroundCommands: ScriptLanguageMap
}

export interface CommandEditorCodeBlockConfig {
    codeBlockLanguageAliases?: Record<string, string>
    codeBlockTerminalCommands?: Partial<Record<ScriptLanguage, string>>
    codeBlockBackgroundCommands?: Partial<Record<ScriptLanguage, string>>
    /** Legacy config key kept for migration. */
    codeBlockTerminalFileCommands?: Partial<Record<ScriptLanguage, string>>
    /** Legacy config key kept for migration. */
    codeBlockBackgroundRunners?: Partial<Record<ScriptLanguage, string>>
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
    python: 'python3 {file}',
    bash: 'bash {file}',
    powershell: 'pwsh -NoProfile -ExecutionPolicy Bypass -File {file}',
}

export const DEFAULT_CODE_BLOCK_TERMINAL_COMMANDS_WINDOWS: ScriptLanguageMap = {
    python: 'py -3 {file}',
    bash: 'wsl bash {file}',
    powershell: 'powershell -NoProfile -ExecutionPolicy Bypass -File {file}',
}

export const DEFAULT_CODE_BLOCK_BACKGROUND_COMMANDS_UNIX: ScriptLanguageMap = {
    python: 'python3 -u -',
    bash: 'bash -s',
    powershell: 'pwsh -NoProfile -NonInteractive -Command -',
}

export const DEFAULT_CODE_BLOCK_BACKGROUND_COMMANDS_WINDOWS: ScriptLanguageMap = {
    python: 'py -3 -u -',
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
        if (isScriptLanguage(language)) {
            normalized[tag.toLowerCase()] = language
        }
    }
    return normalized
}

function normalizeCommandMap (
    commands: Partial<Record<ScriptLanguage, string>> | undefined,
): Partial<ScriptLanguageMap> {
    const normalized: Partial<ScriptLanguageMap> = {}
    for (const language of ['python', 'bash', 'powershell'] as ScriptLanguage[]) {
        const command = commands?.[language]
        if (typeof command === 'string' && command.trim()) {
            normalized[language] = command
        }
    }
    return normalized
}

function isScriptLanguage (value: string): value is ScriptLanguage {
    return value === 'python' || value === 'bash' || value === 'powershell'
}
