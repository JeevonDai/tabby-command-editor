// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'
import { ChildProcessWithoutNullStreams, execSync, spawn } from 'child_process'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import { Writable } from 'stream'
import { injectTerminalBridgeApi } from './terminalPythonBridge'
import type { PythonBridgeBinding } from './terminalPythonBridge'
import {
    CodeBlockRunSettings,
    parseCommandLine,
    resolveCodeBlockRunSettings,
    ScriptLanguage,
} from './codeBlockRunConfig'

export type { ScriptLanguage } from './codeBlockRunConfig'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const WINDOWS_APPS_PYTHON_STUB = /\\Microsoft\\WindowsApps\\/i
const TABBY_SEND_PREFIX = '\x1eTABBY_SEND:'

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
    /** Feed raw output from the terminal bound to this background script. */
    writeTerminalOutput: (data: string | Buffer) => void
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
    const position = editor.getPosition()
    if (!position) {
        return null
    }
    return findRunnableCodeBlockAtLine(editor, position.lineNumber, settings)
}

export function findRunnableCodeBlockAtLine (
    editor: monaco.editor.IStandaloneCodeEditor,
    lineNumber: number,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): RunnableCodeBlock | null {
    const runnableLanguages = new Set(Object.keys(settings.languageAliases))
    const model = editor.getModel()
    if (!model) {
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
            lineNumber >= fence.startLine
            && lineNumber <= line
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
        && lineNumber >= fence.startLine
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
    let terminalInput: Writable | null = null
    let noteTerminalActivity: (() => void) | null = null
    const pendingTerminalInput: Buffer[] = []
    let cancelled = false

    const promise = new Promise<void>((resolve, reject) => {
        const resolved = resolveScriptLanguage(language, settings)
        if (!resolved) {
            reject(new Error(`Unsupported code block language: ${language}`))
            return
        }

        const scriptLanguage = resolved
        const commandLine = settings.terminalCommands[scriptLanguage]?.trim()
        if (!commandLine) {
            reject(new Error(notFoundMessage(scriptLanguage)))
            return
        }

        const { command, args } = parseCommandLine(commandLine)
        if (!command) {
            reject(new Error(notFoundMessage(scriptLanguage)))
            return
        }

        const payload = normalizeCode(scriptLanguage, code)

        if (cancelled) {
            reject(new Error('Script execution cancelled'))
            return
        }

        const child = spawn(command, args, {
            windowsHide: true,
            shell: false,
            // fd 3 is kept separate from stdin because stdin carries the script itself.
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            env: getSpawnEnvironment(),
        })
        activeChild = child as ChildProcessWithoutNullStreams
        terminalInput = child.stdio[3] as Writable
        terminalInput.on('error', () => { /* process close/error handlers report the result */ })

        const stderr: Buffer[] = []
        let outputBytes = 0
        let settled = false
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
        noteTerminalActivity = resetInactivityTimer

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
        child.stdin.on('error', () => { /* close/error handlers report the result */ })

        child.once('spawn', () => {
            resetInactivityTimer()
            for (const chunk of pendingTerminalInput.splice(0)) {
                terminalInput?.write(chunk)
            }
            child.stdin.end(payload)
        })

        child.once('error', error => {
            finish(() => reject(formatSpawnError(error, command, scriptLanguage)))
        })

        child.once('close', exitCode => {
            finish(() => {
                if (cancelled) {
                    reject(new Error('Script execution cancelled'))
                    return
                }

                const stderrText = Buffer.concat(stderr).toString('utf8').trim()
                if (exitCode !== 0) {
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
    })

    return {
        promise,
        cancel: () => {
            cancelled = true
            terminalInput?.end()
            activeChild?.kill()
        },
        writeTerminalOutput: data => {
            if (cancelled) {
                return
            }
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
            noteTerminalActivity?.()
            if (terminalInput) {
                terminalInput.write(chunk)
            } else {
                pendingTerminalInput.push(chunk)
            }
        },
    }
}

function formatSpawnError (error: Error & { code?: string }, command: string, language: ScriptLanguage): Error {
    if (error.code === 'ENOENT') {
        return new Error(`${language} runner not found: ${command}`)
    }
    return error
}

function normalizeCode (language: ScriptLanguage, code: string): string {
    if (language === 'python') {
        return `${PYTHON_TERMINAL_API}\n${code}`
    }
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
    return 'Script runner was not found.'
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

function shellQuoteSingle (value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

export function buildTerminalCommand (
    scriptPath: string,
    language: ScriptLanguage,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): string {
    const template = settings.terminalCommands[language]
    const quoted = quoteTerminalPath(scriptPath, template)
    return template.replace(/\{file\}/g, quoted)
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
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): TerminalRunPayload {
    const scriptPath = writeTempBashScript(code)
    return {
        mode: 'line',
        command: buildTerminalCommand(scriptPath, 'bash', settings),
    }
}

export type TerminalRunPayload = { mode: 'line', command: string }

function quoteTerminalPath (scriptPath: string, template: string): string {
    if (resolveFilePathStyle(template) === 'wsl') {
        return shellQuoteSingle(windowsPathToWslPath(scriptPath))
    }
    return shellQuoteSingle(scriptPath)
}

/** How `{file}` is quoted before substituting into a TF command template. */
export function resolveFilePathStyle (template: string): 'wsl' | 'win' {
    if (process.platform === 'win32' && /\bwsl\b/i.test(template)) {
        return 'wsl'
    }
    return 'win'
}

export function writeTempPythonScript (code: string, binding?: PythonBridgeBinding): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os')
    const scriptPath = path.join(os.tmpdir(), `tabby-cmd-editor-${Date.now()}.py`)
    const source = binding ? injectTerminalBridgeApi(code, binding) : code
    const normalized = source.endsWith('\n') ? source : `${source}\n`
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

export function resolvePythonTerminalPayload (
    code: string,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
    binding?: PythonBridgeBinding,
): TerminalRunPayload {
    const scriptPath = writeTempPythonScript(code, binding)
    return {
        mode: 'line',
        command: buildTerminalCommand(scriptPath, 'python', settings),
    }
}

export function resolvePowerShellTerminalPayload (
    code: string,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
): TerminalRunPayload {
    const scriptPath = writeTempPowerShellScript(code)
    return {
        mode: 'line',
        command: buildTerminalCommand(scriptPath, 'powershell', settings),
    }
}

export function resolveScriptTerminalPayload (
    language: ScriptLanguage,
    code: string,
    settings: CodeBlockRunSettings = resolveCodeBlockRunSettings(undefined),
    binding?: PythonBridgeBinding,
): TerminalRunPayload {
    switch (language) {
        case 'bash':
            return resolveBashTerminalPayload(code, settings)
        case 'python':
            return resolvePythonTerminalPayload(code, settings, binding)
        case 'powershell':
            return resolvePowerShellTerminalPayload(code, settings)
    }
    const scriptPath = writeTempScript(code, language)
    return {
        mode: 'line',
        command: buildTerminalCommand(scriptPath, language, settings),
    }
}

/** Decode a command emitted by the injected Python tabby.send() API. */
export function decodeTabbySendLine (line: string): string | null {
    if (!line.startsWith(TABBY_SEND_PREFIX)) {
        return null
    }
    try {
        return Buffer.from(line.substring(TABBY_SEND_PREFIX.length), 'base64').toString('utf8')
    } catch {
        return null
    }
}

/**
 * Python-side API backed by fd 3. stdout intentionally remains reserved for commands.
 * Available to code blocks as: tabby.read(), tabby.tail(), tabby.clear(),
 * tabby.mark(), and tabby.expect(pattern, timeout, since).
 */
const PYTHON_TERMINAL_API = String.raw`
import os as _tabby_os
import base64 as _tabby_base64
import re as _tabby_re
import threading as _tabby_threading
import time as _tabby_time

class _TabbyConsole:
    def __init__(self):
        self._text = ""
        self._base = 0
        self._cursor = 0
        self._max_chars = 1024 * 1024
        self._condition = _tabby_threading.Condition()
        _tabby_threading.Thread(target=self._receive, daemon=True).start()

    def send(self, text):
        payload = str(text).encode("utf-8")
        encoded = _tabby_base64.b64encode(payload).decode("ascii")
        print("\x1eTABBY_SEND:" + encoded, flush=True)

    def _receive(self):
        while True:
            try:
                chunk = _tabby_os.read(3, 4096)
            except OSError:
                return
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
            with self._condition:
                self._text += text
                excess = len(self._text) - self._max_chars
                if excess > 0:
                    self._text = self._text[excess:]
                    self._base += excess
                    self._cursor = max(self._cursor, self._base)
                self._condition.notify_all()

    def mark(self):
        with self._condition:
            return self._base + len(self._text)

    def clear(self):
        with self._condition:
            self._cursor = self._base + len(self._text)
            return self._cursor

    def tail(self, last=4096):
        with self._condition:
            return self._text[-max(0, int(last)):]

    def read(self, timeout=0):
        deadline = _tabby_time.monotonic() + max(0, float(timeout))
        with self._condition:
            while self._cursor >= self._base + len(self._text):
                remaining = deadline - _tabby_time.monotonic()
                if remaining <= 0:
                    return ""
                self._condition.wait(remaining)
            result = self._text[max(0, self._cursor - self._base):]
            self._cursor = self._base + len(self._text)
            return result

    def expect(self, pattern, timeout=5, since=None, flags=0):
        expression = _tabby_re.compile(pattern, flags) if isinstance(pattern, str) else pattern
        start = self._cursor if since is None else max(0, int(since))
        deadline = _tabby_time.monotonic() + max(0, float(timeout))
        with self._condition:
            while True:
                match = expression.search(self._text, max(0, start - self._base))
                if match:
                    self._cursor = self._base + match.end()
                    return match
                remaining = deadline - _tabby_time.monotonic()
                if remaining <= 0:
                    tail = self._text[-4000:]
                    raise TimeoutError("terminal expect timed out: %r\n--- terminal tail ---\n%s" % (pattern, tail))
                self._condition.wait(remaining)

tabby = _TabbyConsole()
`

function writeTempScript (code: string, language: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os')
    const extension = language.replace(/[^a-z0-9_-]/gi, '') || 'txt'
    const scriptPath = path.join(os.tmpdir(), `tabby-cmd-editor-${Date.now()}.${extension}`)
    const normalized = code.replace(/\r\n?/g, '\n')
    fs.writeFileSync(scriptPath, normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8')
    return scriptPath
}

function formatBytes (bytes: number): string {
    if (bytes >= 1024 * 1024) {
        return `${bytes / (1024 * 1024)} MiB`
    }
    return `${Math.round(bytes / 1024)} KiB`
}
