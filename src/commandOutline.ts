// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

const MARKDOWN_HEADING_RE = /^\s*(#{1,6})\s+(.+)$/
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
let activePickerClose: (() => void) | null = null

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

function buildHeadingSymbolTree (model: monaco.editor.ITextModel): monaco.languages.DocumentSymbol[] {
    const roots: monaco.languages.DocumentSymbol[] = []
    const stack: { level: number; symbol: monaco.languages.DocumentSymbol }[] = []

    for (let line = 1; line <= model.getLineCount(); line++) {
        const content = model.getLineContent(line)
        const match = content.match(MARKDOWN_HEADING_RE)
        if (!match) {
            continue
        }

        const title = match[2].trim()
        if (!title) {
            continue
        }

        const level = match[1].length
        const symbol: monaco.languages.DocumentSymbol = {
            name: title,
            detail: '',
            kind: monaco.languages.SymbolKind.Module,
            tags: [],
            range: new monaco.Range(line, 1, line, content.length + 1),
            selectionRange: new monaco.Range(line, 1, line, content.length + 1),
            children: [],
        }

        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop()
        }

        if (stack.length === 0) {
            roots.push(symbol)
        } else {
            stack[stack.length - 1].symbol.children!.push(symbol)
        }

        stack.push({ level, symbol })
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
            return buildHeadingSymbolTree(model)
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
        node.element.classList.remove('has-children')
        return
    }

    node.element.classList.add('has-children')
    node.twistie.textContent = node.expanded ? '▾' : '▸'
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
    title.textContent = 'Outline · ↑↓ · → expand · ← collapse · Enter'
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
        item.addEventListener('click', () => jumpToOutlineNode(editor, node))

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
                if (activeNode.children.length === 0) {
                    break
                }
                event.preventDefault()
                event.stopImmediatePropagation()
                if (!activeNode.expanded) {
                    activeNode.expanded = true
                    syncOutlineVisibility(roots)
                    setActiveIndex(activeIndex)
                } else {
                    setActiveIndex(activeIndex + 1)
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
