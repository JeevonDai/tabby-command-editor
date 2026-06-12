// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'
// @ts-ignore - monaco internal module (shares the same singleton as the bundled editor)
import { Registry } from 'monaco-editor/esm/vs/platform/registry/common/platform.js'
// @ts-ignore - monaco internal module
import { Extensions as QuickAccessExtensions } from 'monaco-editor/esm/vs/platform/quickinput/common/quickAccess.js'
// @ts-ignore - monaco internal module
import { MenuRegistry, MenuId } from 'monaco-editor/esm/vs/platform/actions/common/actions.js'

const COMMAND_PALETTE_ACTION_ID = 'editor.action.quickCommand'

const MARKDOWN_HEADING_RE = /^\s*(#{1,6})\s+(.+)$/
const LINE_COMMENT_RE = /^\s*\/\/+\s?(.*)$/
const OUTLINE_PICKER_CLASS = 'command-editor-outline-picker'
const OUTLINE_LANGUAGES = [
    'command-editor',
    'shell',
    'plaintext',
    'powershell',
    'python',
    'javascript',
    'typescript',
    'markdown',
    'yaml',
    'ini',
    'bat',
    'json',
]

export interface MarkdownHeading {
    line: number
    level: number
    title: string
}

interface OutlineNode {
    heading: MarkdownHeading
    children: OutlineNode[]
    parent: OutlineNode | null
    element: HTMLButtonElement
    twistie: HTMLSpanElement
    expanded: boolean
}

let featuresRegistered = false
let quickAccessPruned = false
let activePickerClose: (() => void) | null = null

/**
 * Remove the command palette (">" / F1) and the help provider that powers
 * "Show all Quick Access Providers" from Monaco's quick access registry, so only
 * Go to Line (:) and Go to Symbol (@ / @:) are offered.
 */
export function pruneQuickAccessProviders (): void {
    if (quickAccessPruned) {
        return
    }
    quickAccessPruned = true

    try {
        const registry = Registry.as(QuickAccessExtensions.Quickaccess) as {
            providers?: { prefix?: string }[]
            defaultProvider?: unknown
        } | undefined
        if (!registry) {
            return
        }

        if (Array.isArray(registry.providers)) {
            registry.providers = registry.providers.filter(descriptor => descriptor.prefix !== '>')
        }
        // The help ("show all providers") entry is the default (empty-prefix) provider.
        registry.defaultProvider = undefined
    } catch (err) {
        console.warn('[CommandEditor] Failed to prune quick access providers:', err)
    }

    removeCommandPaletteContextMenuItem()
}

/** Remove the right-click "Command Palette" entry from Monaco's editor context menu. */
function removeCommandPaletteContextMenuItem (): void {
    try {
        const menuItems = (MenuRegistry as unknown as {
            _menuItems?: Map<unknown, { clear: () => void; push: (item: unknown) => void } & Iterable<{ command?: { id?: string } }>>
        })._menuItems
        const list = menuItems?.get(MenuId.EditorContext)
        if (!list) {
            return
        }

        const kept = [...list].filter(item => item.command?.id !== COMMAND_PALETTE_ACTION_ID)
        if (kept.length === [...list].length) {
            return
        }

        list.clear()
        for (const item of kept) {
            list.push(item)
        }
    } catch (err) {
        console.warn('[CommandEditor] Failed to remove command palette context menu item:', err)
    }
}

export function parseMarkdownHeadings (text: string): MarkdownHeading[] {
    const headings: MarkdownHeading[] = []
    const lines = text.split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(MARKDOWN_HEADING_RE)
        if (!match) {
            continue
        }

        const title = match[2].trim()
        if (!title) {
            continue
        }

        headings.push({
            line: i + 1,
            level: match[1].length,
            title,
        })
    }

    return headings
}

function buildOutlineTree (headings: MarkdownHeading[]): OutlineNode[] {
    const roots: OutlineNode[] = []
    const stack: { level: number; node: OutlineNode }[] = []

    for (const heading of headings) {
        const node: OutlineNode = {
            heading,
            children: [],
            parent: null,
            element: null!,
            twistie: null!,
            expanded: false,
        }

        while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
            stack.pop()
        }

        if (stack.length === 0) {
            roots.push(node)
        } else {
            const parent = stack[stack.length - 1].node
            node.parent = parent
            parent.children.push(node)
        }

        stack.push({ level: heading.level, node })
    }

    return roots
}

function walkOutlineNodes (roots: OutlineNode[], visit: (node: OutlineNode) => void): void {
    for (const node of roots) {
        visit(node)
        walkOutlineNodes(node.children, visit)
    }
}

function isOutlineNodeVisible (node: OutlineNode): boolean {
    let current = node.parent
    while (current) {
        if (!current.expanded) {
            return false
        }
        current = current.parent
    }
    return true
}

function getVisibleOutlineNodes (roots: OutlineNode[]): OutlineNode[] {
    const visible: OutlineNode[] = []
    walkOutlineNodes(roots, node => {
        if (isOutlineNodeVisible(node)) {
            visible.push(node)
        }
    })
    return visible
}

/**
 * Build the editor outline symbols used by Monaco's native "Go to Symbol" (Ctrl+Shift+O).
 *
 * Two symbol kinds are emitted so "Go to Symbol by Category" (@:) can split them:
 *   - Markdown headings (`#`)  -> SymbolKind.Module  (category "modules")
 *   - Line comments (`//`)     -> SymbolKind.String  (category "strings")
 * Comments nest under the heading whose section they belong to, so the plain `@`
 * view keeps a readable hierarchy while `@:` regroups everything by kind.
 */
function buildDocumentSymbols (model: monaco.editor.ITextModel): monaco.languages.DocumentSymbol[] {
    const roots: monaco.languages.DocumentSymbol[] = []
    const stack: { level: number; symbol: monaco.languages.DocumentSymbol }[] = []

    const appendSymbol = (symbol: monaco.languages.DocumentSymbol): void => {
        if (stack.length === 0) {
            roots.push(symbol)
        } else {
            stack[stack.length - 1].symbol.children!.push(symbol)
        }
    }

    for (let line = 1; line <= model.getLineCount(); line++) {
        const content = model.getLineContent(line)
        const range = new monaco.Range(line, 1, line, content.length + 1)

        const headingMatch = content.match(MARKDOWN_HEADING_RE)
        if (headingMatch) {
            const title = headingMatch[2].trim()
            if (!title) {
                continue
            }

            const level = headingMatch[1].length
            const symbol: monaco.languages.DocumentSymbol = {
                name: title,
                detail: '',
                kind: monaco.languages.SymbolKind.Module,
                tags: [],
                range,
                selectionRange: range,
                children: [],
            }

            while (stack.length > 0 && stack[stack.length - 1].level >= level) {
                stack.pop()
            }

            appendSymbol(symbol)
            stack.push({ level, symbol })
            continue
        }

        const commentMatch = content.match(LINE_COMMENT_RE)
        if (commentMatch) {
            const text = commentMatch[1].trim()
            if (!text) {
                continue
            }

            appendSymbol({
                name: text,
                detail: '',
                kind: monaco.languages.SymbolKind.String,
                tags: [],
                range,
                selectionRange: range,
                children: [],
            })
        }
    }

    return roots
}

export function registerMarkdownHeadingFeatures (): void {
    if (featuresRegistered) {
        return
    }
    featuresRegistered = true

    monaco.languages.registerDocumentSymbolProvider(OUTLINE_LANGUAGES, {
        provideDocumentSymbols (model) {
            return buildDocumentSymbols(model)
        },
    })
}

function closeActivePicker (): void {
    activePickerClose?.()
    activePickerClose = null
}

export function closeHeadingOutlinePicker (): void {
    closeActivePicker()
}

function updateOutlineTwistie (node: OutlineNode): void {
    if (node.children.length === 0) {
        node.twistie.textContent = ''
        node.twistie.title = ''
        node.element.classList.remove('has-children', 'expanded')
        return
    }

    node.element.classList.add('has-children')
    node.element.classList.toggle('expanded', node.expanded)
    node.twistie.textContent = node.expanded ? '▾' : '▸'
    node.twistie.title = node.expanded ? 'Collapse' : 'Expand'
}

function syncOutlineVisibility (roots: OutlineNode[]): void {
    walkOutlineNodes(roots, node => {
        node.element.style.display = isOutlineNodeVisible(node) ? '' : 'none'
        updateOutlineTwistie(node)
    })
}

function jumpToOutlineNode (editor: monaco.editor.IStandaloneCodeEditor, node: OutlineNode): void {
    editor.setSelection(new monaco.Selection(node.heading.line, 1, node.heading.line, 1))
    editor.revealLineInCenter(node.heading.line)
    editor.focus()
    closeActivePicker()
}

function showEmptyOutlinePicker (mountRoot: HTMLElement): void {
    const picker = document.createElement('div')
    picker.className = OUTLINE_PICKER_CLASS

    const title = document.createElement('div')
    title.className = 'command-editor-outline-picker-title'
    title.textContent = 'Outline'
    picker.appendChild(title)

    const empty = document.createElement('div')
    empty.className = 'command-editor-outline-empty'
    empty.textContent = 'No headings found 鈥?add a Markdown heading (e.g. "# Title").'
    picker.appendChild(empty)

    mountRoot.appendChild(picker)

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopImmediatePropagation()
            closeActivePicker()
        }
    }

    const onMouseDown = (event: MouseEvent): void => {
        if (!(event.target instanceof Node) || picker.contains(event.target)) {
            return
        }
        closeActivePicker()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onMouseDown, true)

    activePickerClose = () => {
        picker.remove()
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('mousedown', onMouseDown, true)
        activePickerClose = null
    }
}

export function showHeadingOutlinePicker (
    editor: monaco.editor.IStandaloneCodeEditor,
    mountRoot: HTMLElement,
): void {
    if (activePickerClose) {
        closeActivePicker()
        return
    }

    const model = editor.getModel()
    if (!model) {
        return
    }

    const roots = buildOutlineTree(parseMarkdownHeadings(model.getValue()))
    if (roots.length === 0) {
        showEmptyOutlinePicker(mountRoot)
        return
    }

    const picker = document.createElement('div')
    picker.className = OUTLINE_PICKER_CLASS

    const title = document.createElement('div')
    title.className = 'command-editor-outline-picker-title'
    title.textContent = 'Outline · ↑↓ · click ▶ to expand · → expand · ← collapse · Enter'
    picker.appendChild(title)

    walkOutlineNodes(roots, node => {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = `command-editor-outline-item level-${node.heading.level}`

        const twistie = document.createElement('span')
        twistie.className = 'command-editor-outline-twistie'

        const label = document.createElement('span')
        label.className = 'command-editor-outline-label'
        label.textContent = node.heading.title

        item.append(twistie, label)
        item.title = `#${'#'.repeat(node.heading.level - 1)} ${node.heading.title}`

        node.element = item
        node.twistie = twistie
        picker.appendChild(item)
    })

    syncOutlineVisibility(roots)

    let activeIndex = 0
    const visibleNodes = (): OutlineNode[] => getVisibleOutlineNodes(roots)

    const setActiveIndex = (index: number): void => {
        const nodes = visibleNodes()
        if (nodes.length === 0) {
            return
        }

        activeIndex = Math.max(0, Math.min(index, nodes.length - 1))
        walkOutlineNodes(roots, node => node.element.classList.remove('active'))
        const activeNode = nodes[activeIndex]
        activeNode.element.classList.add('active')
        activeNode.element.scrollIntoView({ block: 'nearest' })
    }

    walkOutlineNodes(roots, node => {
        node.twistie.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            if (node.children.length === 0) {
                return
            }
            node.expanded = !node.expanded
            syncOutlineVisibility(roots)
            const index = visibleNodes().indexOf(node)
            if (index >= 0) {
                setActiveIndex(index)
            }
        })

        node.element.addEventListener('click', () => jumpToOutlineNode(editor, node))
    })

    setActiveIndex(0)
    mountRoot.appendChild(picker)

    const onKeyDown = (event: KeyboardEvent): void => {
        const nodes = visibleNodes()
        if (nodes.length === 0) {
            return
        }

        const activeNode = nodes[activeIndex] ?? nodes[0]

        switch (event.key) {
            case 'Escape':
                event.preventDefault()
                event.stopImmediatePropagation()
                closeActivePicker()
                break
            case 'ArrowDown':
                event.preventDefault()
                event.stopImmediatePropagation()
                setActiveIndex(activeIndex + 1)
                break
            case 'ArrowUp':
                event.preventDefault()
                event.stopImmediatePropagation()
                setActiveIndex(activeIndex - 1)
                break
            case 'ArrowRight':
                event.preventDefault()
                event.stopImmediatePropagation()
                if (activeNode.children.length > 0 && !activeNode.expanded) {
                    activeNode.expanded = true
                    syncOutlineVisibility(roots)
                    setActiveIndex(activeIndex)
                }
                break
            case 'ArrowLeft':
                event.preventDefault()
                event.stopImmediatePropagation()
                if (activeNode.expanded && activeNode.children.length > 0) {
                    activeNode.expanded = false
                    syncOutlineVisibility(roots)
                    setActiveIndex(activeIndex)
                    break
                }
                if (activeNode.parent) {
                    const parent = activeNode.parent
                    const nextVisible = visibleNodes()
                    const parentIndex = nextVisible.indexOf(parent)
                    setActiveIndex(parentIndex >= 0 ? parentIndex : activeIndex)
                }
                break
            case 'Enter':
                event.preventDefault()
                event.stopImmediatePropagation()
                jumpToOutlineNode(editor, activeNode)
                break
        }
    }

    const onMouseDown = (event: MouseEvent): void => {
        if (!(event.target instanceof Node) || picker.contains(event.target)) {
            return
        }
        closeActivePicker()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onMouseDown, true)

    activePickerClose = () => {
        picker.remove()
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('mousedown', onMouseDown, true)
        activePickerClose = null
    }
}
