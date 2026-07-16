import { Injectable, OnDestroy } from '@angular/core'
import { AppService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { PythonBridgeTerminal, TerminalPythonBridge } from './terminalPythonBridge'

@Injectable()
export class TerminalPythonBridgeService implements OnDestroy {
    private readonly bridge = new TerminalPythonBridge()
    private readonly ids = new WeakMap<BaseTerminalTabComponent<any>, string>()
    private nextId = 0

    constructor (private app: AppService) {
        this.app.ready$.subscribe(() => {
            void this.bridge.start(() => this.listTerminals()).catch(error => {
                console.error('[CommandEditor] Failed to start Python SDK bridge:', error)
            })
        })
    }

    ngOnDestroy (): void {
        this.bridge.close()
    }

    private listTerminals (): PythonBridgeTerminal[] {
        const active = this.findTerminal(this.app.activeTab)
        const result: PythonBridgeTerminal[] = []
        for (const tab of this.app.tabs) this.collectTerminals(tab, active, result)
        return result
    }

    private collectTerminals (
        tab: unknown,
        active: BaseTerminalTabComponent<any> | null,
        result: PythonBridgeTerminal[],
    ): void {
        if (tab instanceof BaseTerminalTabComponent) {
            let id = this.ids.get(tab)
            if (!id) {
                id = `terminal-${++this.nextId}`
                this.ids.set(tab, id)
            }
            result.push({ id, title: tab.title || id, active: tab === active, terminal: tab })
            return
        }
        if (tab instanceof SplitTabComponent) {
            for (const child of tab.getAllTabs()) this.collectTerminals(child, active, result)
        }
    }

    private findTerminal (tab: unknown): BaseTerminalTabComponent<any> | null {
        if (tab instanceof BaseTerminalTabComponent) return tab
        if (tab instanceof SplitTabComponent) {
            const focused = tab.getFocusedTab()
            if (focused) return this.findTerminal(focused)
        }
        return null
    }
}
