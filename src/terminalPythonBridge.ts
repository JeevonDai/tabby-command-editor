import { randomBytes } from 'crypto'
import { createServer, Server, Socket } from 'net'
import { Subscription } from 'rxjs'
import type { BaseTerminalTabComponent } from 'tabby-terminal'

export interface PythonBridgeBinding {
    host: string
    port: number
    token: string
}

interface BindingState {
    terminal: BaseTerminalTabComponent<any>
    subscription: Subscription
    clients: Set<Socket>
    expiry: ReturnType<typeof setTimeout>
}

/** Loopback IPC retained for external/editor bridge clients. */
export class TerminalPythonBridge {
    private server: Server | null = null
    private port = 0
    private starting: Promise<void> | null = null
    private readonly bindings = new Map<string, BindingState>()

    async bind (terminal: BaseTerminalTabComponent<any>): Promise<PythonBridgeBinding> {
        await this.ensureStarted()
        const token = randomBytes(24).toString('hex')
        const state = {} as BindingState
        Object.assign(state, {
            terminal,
            clients: new Set<Socket>(),
            subscription: terminal.output$.subscribe(data => {
                const message = `${JSON.stringify({ event: 'output', data })}\n`
                for (const client of state.clients) client.write(message)
            }),
            expiry: setTimeout(() => {
                if (state.clients.size === 0) this.release(token)
            }, 60_000),
        })
        this.bindings.set(token, state)
        return { host: '127.0.0.1', port: this.port, token }
    }

    close (): void {
        for (const token of [...this.bindings.keys()]) this.release(token)
        this.server?.close()
        this.server = null
        this.port = 0
    }

    private async ensureStarted (): Promise<void> {
        if (this.server?.listening) return
        if (this.starting) return this.starting
        this.starting = new Promise<void>((resolve, reject) => {
            const server = createServer(socket => this.accept(socket))
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject)
                const address = server.address()
                if (!address || typeof address === 'string') {
                    reject(new Error('Failed to determine Python bridge port'))
                    return
                }
                this.server = server
                this.port = address.port
                resolve()
            })
        }).finally(() => { this.starting = null })
        return this.starting
    }

    private accept (socket: Socket): void {
        socket.setEncoding('utf8')
        let buffer = ''
        let token: string | null = null
        socket.on('data', chunk => {
            buffer += chunk
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const message = JSON.parse(line) as { token?: string; op?: string; text?: string }
                    if (!token) {
                        const state = message.token ? this.bindings.get(message.token) : null
                        if (!state) {
                            socket.end(`${JSON.stringify({ ok: false, error: 'invalid token' })}\n`)
                            return
                        }
                        token = message.token!
                        clearTimeout(state.expiry)
                        state.clients.add(socket)
                        socket.write(`${JSON.stringify({ ok: true })}\n`)
                        continue
                    }
                    const state = this.bindings.get(token)
                    if (state && message.op === 'send' && typeof message.text === 'string') {
                        const commands = message.text.replace(/\r\n?/g, '\n').split('\n')
                        while (commands.length > 1 && commands[commands.length - 1] === '') commands.pop()
                        for (const command of commands) state.terminal.sendInput(`${command}\r`)
                    }
                } catch {
                    socket.write(`${JSON.stringify({ ok: false, error: 'invalid message' })}\n`)
                }
            }
        })
        socket.on('close', () => {
            if (!token) return
            const state = this.bindings.get(token)
            state?.clients.delete(socket)
            if (state?.clients.size === 0) this.release(token)
        })
        socket.on('error', () => socket.destroy())
    }

    private release (token: string): void {
        const state = this.bindings.get(token)
        if (!state) return
        state.subscription.unsubscribe()
        clearTimeout(state.expiry)
        for (const client of state.clients) client.destroy()
        this.bindings.delete(token)
    }
}
