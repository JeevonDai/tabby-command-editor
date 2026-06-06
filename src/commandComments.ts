// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

const MARKDOWN_HEADING_RE = /^\s*(#{1,6})\s+(.+)$/

type MarkdownCommentWrap = 'single' | 'multiline-block' | 'multiline-inline'

/** Markdown-style section heading used for command grouping (not sent to terminal). */
export function isMarkdownHeadingLine (line: string): boolean {
    const match = line.match(MARKDOWN_HEADING_RE)
    return !!match && match[2].trim().length > 0
}

/** Remove block comments: C-style, HTML/Markdown, Python triple-quoted strings. */
export function removeBlockComments (text: string): string {
    return text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/"""[\s\S]*?"""/g, '')
        .replace(/'''[\s\S]*?'''/g, '')
}

/** Strip trailing `//` line comments, respecting simple quoted strings. */
export function stripLineComment (line: string): string {
    let inSingle = false
    let inDouble = false
    let escaped = false

    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (escaped) {
            escaped = false
            continue
        }
        if (ch === '\\' && (inSingle || inDouble)) {
            escaped = true
            continue
        }
        if (!inDouble && ch === '\'' && !inSingle) {
            inSingle = true
            continue
        }
        if (inSingle && ch === '\'') {
            inSingle = false
            continue
        }
        if (!inSingle && ch === '"' && !inDouble) {
            inDouble = true
            continue
        }
        if (inDouble && ch === '"') {
            inDouble = false
            continue
        }

        if (!inSingle && !inDouble && ch === '/' && line[i + 1] === '/') {
            return line.slice(0, i).trimEnd()
        }
    }

    return line
}

/** Prepare editor text for sending: drop block/line comments and markdown headings. */
export function stripComments (text: string): string {
    return removeBlockComments(text)
        .split('\n')
        .filter(line => !isMarkdownHeadingLine(line))
        .map(stripLineComment)
        .join('\n')
}

function getMarkdownCommentWrap (lines: string[]): MarkdownCommentWrap | null {
    if (lines.length === 1) {
        const trimmed = lines[0].trim()
        if (trimmed.startsWith('<!--') && trimmed.endsWith('-->') && trimmed.length > 7) {
            return 'single'
        }
        return null
    }

    const first = lines[0].trim()
    const last = lines[lines.length - 1].trim()
    if (!first.startsWith('<!--') || !last.endsWith('-->')) {
        return null
    }

    if (first === '<!--' && last === '-->') {
        return 'multiline-block'
    }

    return 'multiline-inline'
}

function unwrapSingleLine (line: string): string {
    const match = line.match(/^(\s*)<!--\s?(.*?)\s?-->(\s*)$/)
    return match ? `${match[1]}${match[2]}${match[3]}` : line
}

function wrapSingleLine (line: string): string {
    const match = line.match(/^(\s*)(.*?)(\s*)$/)
    if (!match) {
        return `<!-- ${line} -->`
    }
    return `${match[1]}<!-- ${match[2]} -->${match[3]}`
}

function wrapLines (lines: string[]): string {
    if (lines.length === 1) {
        return wrapSingleLine(lines[0])
    }

    const indent = lines[0].match(/^\s*/)?.[0] ?? ''
    return `${indent}<!--\n${lines.join('\n')}\n${indent}-->`
}

function unwrapMultilineBlock (lines: string[]): string {
    return lines.slice(1, -1).join('\n')
}

function unwrapMultilineInline (lines: string[]): string {
    const result = [...lines]
    result[0] = result[0].replace(/^\s*<!--\s?/, '')
    result[result.length - 1] = result[result.length - 1].replace(/\s?-->\s*$/, '')
    return result.join('\n')
}

/** Toggle Markdown/HTML block comment (`<!-- -->`) on the current selection or line(s). */
export function toggleMarkdownComment (editor: monaco.editor.IStandaloneCodeEditor): void {
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || !model) {
        return
    }

    const startLine = selection.startLineNumber
    const endLine = selection.endLineNumber
    const editRange = selection.isEmpty()
        ? new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine))
        : new monaco.Range(startLine, selection.startColumn, endLine, selection.endColumn)

    const lines = selection.isEmpty()
        ? Array.from({ length: endLine - startLine + 1 }, (_, index) => model.getLineContent(startLine + index))
        : model.getValueInRange(editRange).split('\n')

    const wrapKind = getMarkdownCommentWrap(lines)
    let newText: string

    if (wrapKind === 'single') {
        newText = unwrapSingleLine(lines[0])
    } else if (wrapKind === 'multiline-block') {
        newText = unwrapMultilineBlock(lines)
    } else if (wrapKind === 'multiline-inline') {
        newText = unwrapMultilineInline(lines)
    } else {
        newText = wrapLines(lines)
    }

    editor.executeEdits('toggle-markdown-comment', [{
        range: editRange,
        text: newText,
        forceMoveMarkers: true,
    }])
}
