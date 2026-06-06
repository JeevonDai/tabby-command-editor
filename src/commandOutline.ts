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

let featuresRegistered = false
let activePickerClose: (() => void) | null = null

export function parseMarkdownHeadings (text: string): MarkdownHeading[] {
    const headings: MarkdownHeading[] = []
    const lines = text.split('\n')

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

    const headings = parseMarkdownHeadings(model.getValue())
    if (headings.length === 0) {
        return
    }

    const picker = document.createElement('div')
    picker.className = OUTLINE_PICKER_CLASS

    const title = document.createElement('div')
    title.className = 'command-editor-outline-picker-title'
    title.textContent = 'Outline (Ctrl+Q)'
    picker.appendChild(title)

    for (const heading of headings) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = `command-editor-outline-item level-${heading.level}`
        item.textContent = heading.title
        item.title = `#${'#'.repeat(heading.level - 1)} ${heading.title}`
        item.addEventListener('click', () => {
            editor.setSelection(new monaco.Selection(heading.line, 1, heading.line, 1))
            editor.revealLineInCenter(heading.line)
            editor.focus()
            closeActivePicker()
        })
        picker.appendChild(item)
    }

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
