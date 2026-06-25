// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'
import { ChildProcessWithoutNullStreams, execSync, spawn } from 'child_process'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import {
    CodeBlockRunSettings,
    CodeBlockTerminalFileCommands,
    resolveCodeBlockRunSettings,
    ScriptLanguage,
} from './codeBlockRunConfig'

export type { ScriptLanguage } from './codeBlockRunConfig'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const WINDOWS_APPS_PYTHON_STUB = /\\Microsoft\\WindowsApps\\/i
const WINDOWS_STORE_PYTHON_MESSAGE = /Microsoft Store|App execution aliases/i
const WINDOWS_PYTHON_STUB_EXIT_CODE = 9009

export interface RunnableCodeBlock {
    code: string
    startLine: number
    endLine: number
    /** The raw fence language tag, lower-cased (e.g. "python", "bash", "ps1"). */
    language: string
}

export interface CodeExecution {
    promise: Promise<void>
    cancel: () => void
}

interface Fence {
    marker: '`' | '~'
    length: number
    language: string
    startLine: number
}

export function resolveScriptLanguage (
    language: string,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): ScriptLanguage | null {
    return settings.languageAliases[language.toLowerCase()] ?? null
}

export function findRunnableCodeBlockAtCursor (
    editor: monaco.editor.IStandaloneCodeEditor,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): RunnableCodeBlock | null {
    const runnableLanguages = new Set(Object.keys(settings.languageAliases))
    const model = editor.getModel()
    const position = editor.getPosition()
    if (!model || !position) {
        return null
    }

    let fence: Fence | null = null
    for (let line = 1; line <= model.getLineCount(); line++) {
        const content = model.getLineContent(line)

        if (!fence) {
            fence = parseFenceStart(content, line)
            continue
        }

        if (!isFenceEnd(content, fence)) {
            continue
        }

        if (
            position.lineNumber >= fence.startLine
            && position.lineNumber <= line
            && runnableLanguages.has(fence.language)
        ) {
            return {
                code: model.getValueInRange(new monaco.Range(
                    fence.startLine + 1,
                    1,
                    line,
                    1,
                )),
                startLine: fence.startLine,
                endLine: line,
                language: fence.language,
            }
        }

        fence = null
    }

    if (
        fence
        && position.lineNumber >= fence.startLine
        && runnableLanguages.has(fence.language)
    ) {
        return {
            code: model.getValueInRange(new monaco.Range(
                fence.startLine + 1,
                1,
                model.getLineCount(),
                model.getLineMaxColumn(model.getLineCount()),
            )),
            startLine: fence.startLine,
            endLine: model.getLineCount(),
            language: fence.language,
        }
    }

    return null
}

export function runCodeBlock (
    code: string,
    language: string,
    onStdoutLine: (line: string) => void,
    onStderrLine: (line: string) => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): CodeExecution {
    let activeChild: ChildProcessWithoutNullStreams | null = null
    let cancelled = false

    const promise = new Promise<void>((resolve, reject) => {
        const resolved = resolveScriptLanguage(language, settings)
        if (!resolved) {
            reject(new Error(`Unsupported code block language: ${language}`))
            return
        }

        const scriptLanguage = resolved
        const runners = settings.backgroundRunners[scriptLanguage].filter(runner => runner.command)
        const payload = normalizeCode(scriptLanguage, code)

        const tryRunner = (index: number): void => {
            if (cancelled) {
                reject(new Error('Script execution cancelled'))
                return
            }

            const runner = runners[index]
            if (!runner) {
                reject(new Error(notFoundMessage(scriptLanguage)))
                return
            }

            const child = spawn(runner.command, runner.args, {
                windowsHide: true,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: getSpawnEnvironment(),
            })
            activeChild = child

            const stderr: Buffer[] = []
            let outputBytes = 0
            let settled = false
            let started = false
            let stdoutBuffer = ''
            let stderrBuffer = ''
            const stdoutDecoder = new StringDecoder('utf8')
            const stderrDecoder = new StringDecoder('utf8')
            let timer: ReturnType<typeof setTimeout>

            const finish = (callback: () => void): void => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(timer)
                activeChild = null
                callback()
            }

            const resetInactivityTimer = (): void => {
                clearTimeout(timer)
                timer = setTimeout(() => {
                    child.kill()
                    finish(() => reject(new Error(
                        `Script produced no output for ${Math.round(timeoutMs / 1000)} seconds`,
                    )))
                }, timeoutMs)
            }

            const countOutput = (chunk: Buffer): boolean => {
                outputBytes += chunk.length
                if (outputBytes > maxOutputBytes) {
                    child.kill()
                    finish(() => reject(new Error(`Script output exceeded ${formatBytes(maxOutputBytes)}`)))
                    return false
                }
                resetInactivityTimer()
                return true
            }

            const emitLine = (callback: (line: string) => void, line: string): boolean => {
                try {
                    callback(line)
                    return true
                } catch (error) {
                    child.kill()
                    finish(() => reject(error))
                    return false
                }
            }

            child.stdout.on('data', (chunk: Buffer) => {
                if (!countOutput(chunk)) {
                    return
                }

                stdoutBuffer += stdoutDecoder.write(chunk)
                const lines = stdoutBuffer.split(/\r\n|\r|\n/)
                stdoutBuffer = lines.pop() ?? ''
                for (const line of lines) {
                    if (!emitLine(onStdoutLine, line)) {
                        return
                    }
                }
            })
            child.stderr.on('data', (chunk: Buffer) => {
                if (!countOutput(chunk)) {
                    return
                }

                stderr.push(chunk)
                stderrBuffer += stderrDecoder.write(chunk)
                const lines = stderrBuffer.split(/\r\n|\r|\n/)
                stderrBuffer = lines.pop() ?? ''
                for (const line of lines) {
                    if (!emitLine(onStderrLine, line)) {
                        return
                    }
                }
            })
            // The interpreter may exit before consuming stdin (for example on an early syntax error).
            child.stdin.on('error', () => { /* close/error handlers report the result */ })

            child.once('spawn', () => {
                started = true
                resetInactivityTimer()
                child.stdin.end(payload)
            })

            child.once('error', error => {
                if (!started && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                    finish(() => tryRunner(index + 1))
                    return
                }
                finish(() => reject(error))
            })

            child.once('close', exitCode => {
                finish(() => {
                    if (cancelled) {
                        reject(new Error('Script execution cancelled'))
                        return
                    }

                    const stderrText = Buffer.concat(stderr).toString('utf8').trim()
                    if (exitCode !== 0) {
                        if (scriptLanguage === 'python' && isWindowsPythonStubFailure(exitCode, stderrText)) {
                            tryRunner(index + 1)
                            return
                        }
                        reject(new Error(stderrText || `Script exited with code ${exitCode}`))
                        return
                    }

                    stdoutBuffer += stdoutDecoder.end()
                    stderrBuffer += stderrDecoder.end()
                    if (stdoutBuffer) {
                        try {
                            onStdoutLine(stdoutBuffer)
                        } catch (error) {
                            reject(error)
                            return
                        }
                    }
                    if (stderrBuffer) {
                        try {
                            onStderrLine(stderrBuffer)
                        } catch (error) {
                            reject(error)
                            return
                        }
                    }
                    resolve()
                })
            })
        }

        tryRunner(0)
    })

    return {
        promise,
        cancel: () => {
            cancelled = true
            activeChild?.kill()
        },
    }
}

function normalizeCode (language: ScriptLanguage, code: string): string {
    if (language === 'bash') {
        // bash chokes on CR (`$'\r': command not found`) when the editor uses CRLF endings.
        const normalized = code.replace(/\r\n?/g, '\n')
        return normalized.endsWith('\n') ? normalized : `${normalized}\n`
    }
    if (language === 'powershell' && process.platform === 'win32') {
        // Electron/Tabby often inherit a stripped PATH; refresh from registry before user code runs.
        // Must stay on one line: multiline `@(...)` array literals break `powershell -Command -` stdin parsing.
        const preamble = [
            '$__paths = @([System.Environment]::GetEnvironmentVariable(\'Path\', \'Machine\'), [System.Environment]::GetEnvironmentVariable(\'Path\', \'User\')) | Where-Object { $_ }',
            '$env:Path = ($__paths -join \';\')',
            '',
        ].join('\n')
        return `${preamble}${code}`
    }
    return code
}

let cachedSpawnEnvironment: NodeJS.ProcessEnv | null = null

function getSpawnEnvironment (): NodeJS.ProcessEnv {
    if (process.platform !== 'win32') {
        return process.env
    }
    if (!cachedSpawnEnvironment) {
        cachedSpawnEnvironment = buildWindowsSpawnEnvironment()
    }
    return cachedSpawnEnvironment
}

function buildWindowsSpawnEnvironment (): NodeJS.ProcessEnv {
    const registryPath = readWindowsRegistryPath()
    const inheritedPath = process.env.PATH ?? process.env.Path ?? ''
    const discoveredPath = discoverWindowsToolDirectories(registryPath || inheritedPath)
    const mergedPath = mergePathSegments(registryPath, discoveredPath, inheritedPath)

    return {
        ...process.env,
        PATH: mergedPath,
        Path: mergedPath,
    }
}

function readWindowsRegistryPath (): string {
    const paths: string[] = []
    const keys = [
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
        'HKCU\\Environment',
    ]

    for (const key of keys) {
        try {
            const output = execSync(`reg query "${key}" /v Path`, {
                encoding: 'utf8',
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            const match = output.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
            if (match?.[1]) {
                paths.push(expandWindowsEnvVars(match[1].trim()))
            }
        } catch {
            // Ignore missing or unreadable registry keys.
        }
    }

    return mergePathSegments(...paths)
}

function discoverWindowsToolDirectories (searchPath: string): string {
    const directories = new Set<string>()
    const env = { ...process.env, PATH: searchPath, Path: searchPath }

    for (const command of ['python', 'python3', 'py']) {
        try {
            const output = execSync(`where ${command}`, {
                encoding: 'utf8',
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
            })
            for (const line of output.split(/\r?\n/)) {
                const trimmed = line.trim()
                if (!trimmed || WINDOWS_APPS_PYTHON_STUB.test(trimmed)) {
                    continue
                }
                directories.add(path.dirname(trimmed))
            }
        } catch {
            // Command not on PATH yet.
        }
    }

    return [...directories].join(';')
}

function expandWindowsEnvVars (value: string): string {
    return value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
}

function mergePathSegments (...segments: string[]): string {
    const merged: string[] = []
    const seen = new Set<string>()

    for (const segment of segments) {
        for (const entry of segment.split(';')) {
            const normalized = entry.trim()
            if (!normalized) {
                continue
            }
            const key = normalized.toLowerCase()
            if (seen.has(key)) {
                continue
            }
            seen.add(key)
            merged.push(normalized)
        }
    }

    return merged.join(';')
}

function notFoundMessage (language: ScriptLanguage): string {
    switch (language) {
        case 'python':
            return 'Python was not found. Install Python 3 and make python3, python, or py available in PATH.'
        case 'bash':
            return 'bash was not found. Install bash (Git Bash or WSL) and make it available in PATH.'
        case 'powershell':
            return 'PowerShell was not found. Make powershell or pwsh available in PATH.'
    }
}

function parseFenceStart (line: string, lineNumber: number): Fence | null {
    const match = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`~]*)?.*$/)
    if (!match) {
        return null
    }

    return {
        marker: match[1][0] as '`' | '~',
        length: match[1].length,
        language: (match[2] ?? '').toLowerCase(),
        startLine: lineNumber,
    }
}

function isFenceEnd (line: string, fence: Fence): boolean {
    const marker = fence.marker === '`' ? '`' : '~'
    return new RegExp(`^\\s*${marker}{${fence.length},}\\s*$`).test(line)
}

export type TerminalShellKind = 'wsl' | 'msys' | 'powershell' | 'unix' | 'ssh' | 'unknown'

export interface TerminalProfileHint {
    id?: string
    name?: string
    provider?: string
    options?: { name?: string, [key: string]: unknown }
}

export function normalizeBashScript (code: string): string {
    const normalized = code.replace(/\r\n?/g, '\n')
    return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}

export function windowsPathToWslPath (windowsPath: string): string {
    const forward = windowsPath.replace(/\\/g, '/')
    const match = forward.match(/^([a-zA-Z]):\/(.*)$/)
    if (!match) {
        return forward
    }
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`
}

export function windowsPathToMsysPath (windowsPath: string): string {
    const forward = windowsPath.replace(/\\/g, '/')
    const match = forward.match(/^([a-zA-Z]):\/(.*)$/)
    if (!match) {
        return forward
    }
    return `/${match[1].toLowerCase()}/${match[2]}`
}

export function detectTerminalShellKind (
    profile: TerminalProfileHint | undefined,
    label = '',
): TerminalShellKind {
    const parts = [
        profile?.provider,
        profile?.id,
        profile?.name,
        profile?.options?.name,
        label,
    ].filter(Boolean).join(' ').toLowerCase()

    if (/\bssh\b|tabby-ssh|remote/.test(parts)) {
        return 'ssh'
    }
    if (/wsl|ubuntu|debian|fedora|arch|kali|opensuse|alpine|\bzsh\b|\bbash\b/.test(parts)) {
        return 'wsl'
    }
    if (/git\s*bash|msys|mingw|cygwin/.test(parts)) {
        return 'msys'
    }
    if (/powershell|pwsh|windows\s*powershell/.test(parts)) {
        return 'powershell'
    }
    if (process.platform !== 'win32') {
        return 'unix'
    }
    return 'unknown'
}

function shellQuoteSingle (value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

export function buildBashTerminalCommand (
    scriptPath: string,
    shellKind: TerminalShellKind,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): string {
    const quoted = quoteTerminalPath(scriptPath, shellKind)
    return buildTerminalFileCommand('bash', shellKind, quoted, settings.terminalFileCommands.bash)
}

export function buildBashHeredocPayload (code: string): string {
    const normalized = normalizeBashScript(code)
    let delimiter = 'TABBY_SCRIPT_EOF'
    while (normalized.includes(delimiter)) {
        delimiter += '_'
    }
    return `bash <<'${delimiter}'\n${normalized}${delimiter}`
}

export function writeTempBashScript (code: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os')
    const scriptPath = path.join(os.tmpdir(), `tabby-cmd-editor-${Date.now()}.sh`)
    fs.writeFileSync(scriptPath, normalizeBashScript(code), 'utf8')
    return scriptPath
}

export function resolveBashTerminalPayload (
    code: string,
    shellKind: TerminalShellKind,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): TerminalRunPayload {
    if (shellKind === 'ssh') {
        return { mode: 'multiline', command: buildBashHeredocPayload(code) }
    }

    const scriptPath = writeTempBashScript(code)
    return {
        mode: 'line',
        command: buildBashTerminalCommand(scriptPath, shellKind, settings),
    }
}

export type TerminalRunPayload = { mode: 'line', command: string } | { mode: 'multiline', command: string }

function quoteTerminalPath (scriptPath: string, shellKind: TerminalShellKind): string {
    if (process.platform === 'win32' && (shellKind === 'wsl' || shellKind === 'unix')) {
        return shellQuoteSingle(windowsPathToWslPath(scriptPath))
    }
    if (process.platform === 'win32' && shellKind === 'msys') {
        return shellQuoteSingle(windowsPathToMsysPath(scriptPath))
    }
    return shellQuoteSingle(scriptPath)
}

export function writeTempPythonScript (code: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os')
    const scriptPath = path.join(os.tmpdir(), `tabby-cmd-editor-${Date.now()}.py`)
    const normalized = code.endsWith('\n') ? code : `${code}\n`
    fs.writeFileSync(scriptPath, normalized, 'utf8')
    return scriptPath
}

export function writeTempPowerShellScript (code: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os')
    const scriptPath = path.join(os.tmpdir(), `tabby-cmd-editor-${Date.now()}.ps1`)
    const normalized = code.replace(/\r\n?/g, '\n')
    fs.writeFileSync(scriptPath, normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8')
    return scriptPath
}

export function buildPythonHeredocPayload (code: string): string {
    const normalized = code.endsWith('\n') ? code : `${code}\n`
    let delimiter = 'TABBY_PYTHON_EOF'
    while (normalized.includes(delimiter)) {
        delimiter += '_'
    }
    return `python3 -u <<'${delimiter}'\n${normalized}${delimiter}`
}

export function buildPowerShellHeredocPayload (code: string): string {
    const normalized = code.replace(/\r\n?/g, '\n')
    const body = normalized.endsWith('\n') ? normalized : `${normalized}\n`
    let delimiter = 'TABBY_PWSH_EOF'
    while (body.includes(delimiter)) {
        delimiter += '_'
    }
    return `pwsh -NoProfile -Command - <<'${delimiter}'\n${body}${delimiter}`
}

export function buildPythonTerminalCommand (
    scriptPath: string,
    shellKind: TerminalShellKind,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): string {
    const quoted = quoteTerminalPath(scriptPath, shellKind)
    return buildTerminalFileCommand('python', shellKind, quoted, settings.terminalFileCommands.python)
}

export function buildPowerShellTerminalCommand (
    scriptPath: string,
    shellKind: TerminalShellKind,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): string {
    const quoted = quoteTerminalPath(scriptPath, shellKind)
    return buildTerminalFileCommand('powershell', shellKind, quoted, settings.terminalFileCommands.powershell)
}

export function resolvePythonTerminalPayload (
    code: string,
    shellKind: TerminalShellKind,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): TerminalRunPayload {
    if (shellKind === 'ssh') {
        return { mode: 'multiline', command: buildPythonHeredocPayload(code) }
    }

    const scriptPath = writeTempPythonScript(code)
    return {
        mode: 'line',
        command: buildPythonTerminalCommand(scriptPath, shellKind, settings),
    }
}

export function resolvePowerShellTerminalPayload (
    code: string,
    shellKind: TerminalShellKind,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): TerminalRunPayload {
    if (shellKind === 'ssh') {
        return { mode: 'multiline', command: buildPowerShellHeredocPayload(code) }
    }

    const scriptPath = writeTempPowerShellScript(code)
    return {
        mode: 'line',
        command: buildPowerShellTerminalCommand(scriptPath, shellKind, settings),
    }
}

export function resolveScriptTerminalPayload (
    language: ScriptLanguage,
    code: string,
    shellKind: TerminalShellKind,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): TerminalRunPayload {
    switch (language) {
        case 'bash':
            return resolveBashTerminalPayload(code, shellKind, settings)
        case 'python':
            return resolvePythonTerminalPayload(code, shellKind, settings)
        case 'powershell':
            return resolvePowerShellTerminalPayload(code, shellKind, settings)
    }
}

function buildTerminalFileCommand (
    language: ScriptLanguage,
    shellKind: TerminalShellKind,
    quotedFile: string,
    commands: CodeBlockTerminalFileCommands,
): string {
    const template = pickTerminalFileTemplate(commands, shellKind)
    return template.replace(/\{file\}/g, quotedFile)
}

function pickTerminalFileTemplate (
    commands: CodeBlockTerminalFileCommands,
    shellKind: TerminalShellKind,
): string {
    switch (shellKind) {
        case 'wsl':
            return commands.wsl ?? commands.default
        case 'unix':
            return commands.unix ?? commands.wsl ?? commands.default
        case 'msys':
            return commands.msys ?? commands.default
        case 'powershell':
            return commands.powershell ?? commands.default
        case 'unknown':
            return commands.unknown ?? commands.default
        case 'ssh':
            return commands.ssh ?? commands.default
        default:
            return commands.default
    }
}

function isWindowsPythonStubFailure (exitCode: number | null, stderrText: string): boolean {
    if (process.platform !== 'win32') {
        return false
    }
    return exitCode === WINDOWS_PYTHON_STUB_EXIT_CODE
        || WINDOWS_STORE_PYTHON_MESSAGE.test(stderrText)
}

function formatBytes (bytes: number): string {
    if (bytes >= 1024 * 1024) {
        return `${bytes / (1024 * 1024)} MiB`
    }
    return `${Math.round(bytes / 1024)} KiB`
}
