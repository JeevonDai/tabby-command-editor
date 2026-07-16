import { randomBytes } from 'crypto'
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, Server, Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Subscription } from 'rxjs'
import type { BaseTerminalTabComponent } from 'tabby-terminal'

export interface PythonBridgeBinding {
    host: string
    port: number
    token: string
}

export interface PythonBridgeTerminal {
    id: string
    title: string
    active: boolean
    terminal: BaseTerminalTabComponent<any>
}

export interface PythonBridgeTerminalInfo {
    id: string
    title: string
    active: boolean
}

type TerminalProvider = () => PythonBridgeTerminal[]

interface BindingState {
    terminal: BaseTerminalTabComponent<any>
    subscription: Subscription
    clients: Set<Socket>
    expiry: ReturnType<typeof setTimeout>
}

interface ClientState {
    authenticated: boolean
    legacyToken: string | null
    terminal: BaseTerminalTabComponent<any> | null
    outputSubscription: Subscription | null
}

interface BridgeMessage {
    id?: number | string
    token?: string
    op?: string
    terminal?: string
    text?: string
}

const BRIDGE_PROTOCOL_VERSION = 1

/**
 * Loopback JSON-lines bridge used by the importable Python SDK.
 *
 * bind() remains available for the original one-terminal/token workflow. start()
 * enables discovery, terminal enumeration and long-lived external IDE clients.
 */
export class TerminalPythonBridge {
    private server: Server | null = null
    private port = 0
    private starting: Promise<void> | null = null
    private readonly bindings = new Map<string, BindingState>()
    private readonly clients = new Set<Socket>()
    private terminalProvider: TerminalProvider | null = null
    private discoveryToken: string | null = null
    private discoveryPath: string | null = null

    async start (terminalProvider: TerminalProvider): Promise<PythonBridgeBinding> {
        this.terminalProvider = terminalProvider
        await this.ensureStarted()
        if (!this.discoveryToken) this.discoveryToken = randomBytes(32).toString('hex')
        this.writeDiscoveryFile()
        return { host: '127.0.0.1', port: this.port, token: this.discoveryToken }
    }

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
        for (const client of this.clients) client.destroy()
        this.clients.clear()
        this.server?.close()
        this.server = null
        this.port = 0
        if (this.discoveryPath) {
            try { unlinkSync(this.discoveryPath) } catch { /* already removed */ }
        }
        this.discoveryPath = null
        this.discoveryToken = null
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
        this.clients.add(socket)
        socket.setEncoding('utf8')
        const client: ClientState = {
            authenticated: false,
            legacyToken: null,
            terminal: null,
            outputSubscription: null,
        }
        let buffer = ''
        socket.on('data', chunk => {
            buffer += chunk
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    this.handleMessage(socket, client, JSON.parse(line) as BridgeMessage)
                } catch {
                    this.respond(socket, undefined, false, { error: 'invalid message' })
                }
            }
        })
        socket.on('close', () => this.removeClient(socket, client))
        socket.on('error', () => socket.destroy())
    }

    private handleMessage (socket: Socket, client: ClientState, message: BridgeMessage): void {
        if (!client.authenticated) {
            if (message.token && this.discoveryToken && message.token === this.discoveryToken) {
                client.authenticated = true
                this.respond(socket, message.id, true, { version: BRIDGE_PROTOCOL_VERSION })
                return
            }

            const binding = message.token ? this.bindings.get(message.token) : null
            if (binding) {
                client.authenticated = true
                client.legacyToken = message.token!
                clearTimeout(binding.expiry)
                binding.clients.add(socket)
                this.respond(socket, message.id, true)
                return
            }

            socket.end(`${JSON.stringify({ id: message.id, ok: false, error: 'invalid token' })}\n`)
            return
        }

        if (client.legacyToken) {
            const binding = this.bindings.get(client.legacyToken)
            if (binding && message.op === 'send' && typeof message.text === 'string') {
                this.sendCommands(binding.terminal, message.text)
                this.respond(socket, message.id, true)
            }
            return
        }

        switch (message.op) {
            case 'list':
                this.respond(socket, message.id, true, {
                    terminals: this.getTerminals().map(({ id, title, active }) => ({ id, title, active })),
                })
                return
            case 'connect': {
                const terminal = this.resolveTerminal(message.terminal)
                if (!terminal) {
                    this.respond(socket, message.id, false, { error: 'terminal not found' })
                    return
                }
                client.outputSubscription?.unsubscribe()
                client.terminal = terminal.terminal
                client.outputSubscription = terminal.terminal.output$.subscribe(data => {
                    socket.write(`${JSON.stringify({ event: 'output', data })}\n`)
                })
                this.respond(socket, message.id, true, {
                    terminal: { id: terminal.id, title: terminal.title, active: terminal.active },
                })
                return
            }
            case 'send':
                if (!client.terminal) {
                    this.respond(socket, message.id, false, { error: 'not connected to a terminal' })
                } else if (typeof message.text !== 'string') {
                    this.respond(socket, message.id, false, { error: 'text must be a string' })
                } else {
                    this.sendCommands(client.terminal, message.text)
                    this.respond(socket, message.id, true)
                }
                return
            case 'ping':
                this.respond(socket, message.id, true)
                return
            default:
                this.respond(socket, message.id, false, { error: 'unknown operation' })
        }
    }

    private getTerminals (): PythonBridgeTerminal[] {
        try {
            return this.terminalProvider?.() ?? []
        } catch {
            return []
        }
    }

    private resolveTerminal (id: string | undefined): PythonBridgeTerminal | null {
        const terminals = this.getTerminals()
        if (!id) return terminals.find(item => item.active) ?? terminals[0] ?? null
        return terminals.find(item => item.id === id) ?? null
    }

    private sendCommands (terminal: BaseTerminalTabComponent<any>, text: string): void {
        const commands = text.replace(/\r\n?/g, '\n').split('\n')
        while (commands.length > 1 && commands[commands.length - 1] === '') commands.pop()
        for (const command of commands) terminal.sendInput(`${command}\r`)
    }

    private respond (
        socket: Socket,
        id: number | string | undefined,
        ok: boolean,
        extra: Record<string, unknown> = {},
    ): void {
        socket.write(`${JSON.stringify({ id, ok, ...extra })}\n`)
    }

    private removeClient (socket: Socket, client: ClientState): void {
        this.clients.delete(socket)
        client.outputSubscription?.unsubscribe()
        if (!client.legacyToken) return
        const state = this.bindings.get(client.legacyToken)
        state?.clients.delete(socket)
        if (state?.clients.size === 0) this.release(client.legacyToken)
    }

    private writeDiscoveryFile (): void {
        if (!this.discoveryToken) return
        const suffix = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
        const target = join(tmpdir(), `tabby-command-editor-bridge${suffix}.json`)
        const temporary = `${target}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify({
            version: BRIDGE_PROTOCOL_VERSION,
            host: '127.0.0.1',
            port: this.port,
            token: this.discoveryToken,
            pid: process.pid,
        }), { encoding: 'utf8', mode: 0o600 })
        try { chmodSync(temporary, 0o600) } catch { /* Windows */ }
        renameSync(temporary, target)
        this.discoveryPath = target
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
