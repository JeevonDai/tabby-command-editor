// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'

const PYTHON_LANGUAGES = new Set(['python', 'py'])
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

export interface PythonCodeBlock {
    code: string
    startLine: number
    endLine: number
}

export interface PythonExecution {
    promise: Promise<void>
    cancel: () => void
}

interface Fence {
    marker: '`' | '~'
    length: number
    language: string
    startLine: number
}

interface PythonRunner {
    command: string
    args: string[]
}

export function findPythonCodeBlockAtCursor (
    editor: monaco.editor.IStandaloneCodeEditor,
): PythonCodeBlock | null {
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
            && PYTHON_LANGUAGES.has(fence.language)
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
            }
        }

        fence = null
    }

    if (
        fence
        && position.lineNumber >= fence.startLine
        && PYTHON_LANGUAGES.has(fence.language)
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
        }
    }

    return null
}

export function runPythonCode (
    code: string,
    onStdoutLine: (line: string) => void,
    onStderrLine: (line: string) => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): PythonExecution {
    let activeChild: ChildProcessWithoutNullStreams | null = null
    let cancelled = false

    const promise = new Promise<void>((resolve, reject) => {
        const runners = getPythonRunners()

        const tryRunner = (index: number): void => {
            if (cancelled) {
                reject(new Error('Python execution cancelled'))
                return
            }

            const runner = runners[index]
            if (!runner) {
                reject(new Error('Python was not found. Install Python 3 and make python3, python, or py available in PATH.'))
                return
            }

            const child = spawn(runner.command, runner.args, {
                windowsHide: true,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
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
                        `Python produced no output for ${Math.round(timeoutMs / 1000)} seconds`,
                    )))
                }, timeoutMs)
            }

            const countOutput = (chunk: Buffer): boolean => {
                outputBytes += chunk.length
                if (outputBytes > maxOutputBytes) {
                    child.kill()
                    finish(() => reject(new Error(`Python output exceeded ${formatBytes(maxOutputBytes)}`)))
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
            // Python may exit before consuming stdin (for example on an early syntax error).
            child.stdin.on('error', () => { /* close/error handlers report the result */ })

            child.once('spawn', () => {
                started = true
                resetInactivityTimer()
                child.stdin.end(code)
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
                        reject(new Error('Python execution cancelled'))
                        return
                    }

                    const stderrText = Buffer.concat(stderr).toString('utf8').trim()
                    if (exitCode !== 0) {
                        reject(new Error(stderrText || `Python exited with code ${exitCode}`))
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

function getPythonRunners (): PythonRunner[] {
    if (process.platform === 'win32') {
        return [
            { command: 'py', args: ['-3', '-u', '-'] },
            { command: 'python', args: ['-u', '-'] },
            { command: 'python3', args: ['-u', '-'] },
        ]
    }

    return [
        { command: 'python3', args: ['-u', '-'] },
        { command: 'python', args: ['-u', '-'] },
    ]
}

function formatBytes (bytes: number): string {
    if (bytes >= 1024 * 1024) {
        return `${bytes / (1024 * 1024)} MiB`
    }
    return `${Math.round(bytes / 1024)} KiB`
}
