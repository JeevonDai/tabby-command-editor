// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'
import type { CodeBlockRunSettings } from './codeBlockRunConfig'

const MARKDOWN_HEADING_RE = /^\s*(#{1,6})\s+(.+)$/
const FENCE_START_RE = /^\s*(`{3,}|~{3,})(?:\s*([^`~\s]+))?.*$/

type MarkdownCommentWrap = 'single' | 'multiline-block' | 'multiline-inline'

interface MarkdownFence {
    marker: '`' | '~'
    length: number
    language?: string
    startLine?: number
}

interface ScriptFence {
    language: string
    startLine: number
    endLine: number
}

interface CodeFence {
    startLine: number
    endLine: number | null
}

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
    const lines: string[] = []
    let fence: MarkdownFence | null = null

    for (const line of removeBlockComments(text).split('\n')) {
        if (fence) {
            lines.push(line)
            if (isFenceEnd(line, fence)) {
                fence = null
            }
            continue
        }

        fence = parseFenceStart(line)
        if (fence) {
            lines.push(line)
            continue
        }

        if (!isMarkdownHeadingLine(line)) {
            lines.push(stripLineComment(line))
        }
    }

    return lines.join('\n')
}

function parseFenceStart (line: string): MarkdownFence | null {
    const match = line.match(FENCE_START_RE)
    if (!match) {
        return null
    }
    return {
        marker: match[1][0] as '`' | '~',
        length: match[1].length,
        language: match[2]?.toLowerCase(),
    }
}

function isFenceEnd (line: string, fence: MarkdownFence): boolean {
    const marker = fence.marker === '`' ? '`' : '~'
    return new RegExp(`^\\s*(${marker}{${fence.length},})\\s*$`).test(line)
}

function findScriptFenceForRange (
    model: monaco.editor.ITextModel,
    startLine: number,
    endLine: number,
    settings: CodeBlockRunSettings,
): ScriptFence | null {
    let fence: MarkdownFence | null = null

    for (let line = 1; line <= model.getLineCount(); line++) {
        const content = model.getLineContent(line)

        if (fence) {
            if (isFenceEnd(content, fence)) {
                if (
                    fence.startLine !== undefined
                    && fence.language
                    && startLine > fence.startLine
                    && endLine < line
                    && settings.languageAliases[fence.language]
                ) {
                    return {
                        language: settings.languageAliases[fence.language],
                        startLine: fence.startLine,
                        endLine: line,
                    }
                }
                fence = null
            }
            continue
        }

        fence = parseFenceStart(content)
        if (fence) {
            fence.startLine = line
        }
    }

    if (
        fence?.startLine !== undefined
        && fence.language
        && startLine > fence.startLine
        && settings.languageAliases[fence.language]
    ) {
        return {
            language: settings.languageAliases[fence.language],
            startLine: fence.startLine,
            endLine: model.getLineCount(),
        }
    }

    return null
}

function findCodeFenceForRange (
    model: monaco.editor.ITextModel,
    startLine: number,
    endLine: number,
): CodeFence | null {
    let fence: MarkdownFence | null = null

    for (let line = 1; line <= model.getLineCount(); line++) {
        const content = model.getLineContent(line)

        if (fence) {
            if (isFenceEnd(content, fence)) {
                if (
                    fence.startLine !== undefined
                    && startLine >= fence.startLine
                    && endLine <= line
                ) {
                    return {
                        startLine: fence.startLine,
                        endLine: line,
                    }
                }
                fence = null
            }
            continue
        }

        fence = parseFenceStart(content)
        if (fence) {
            fence.startLine = line
        }
    }

    if (
        fence?.startLine !== undefined
        && startLine >= fence.startLine
        && endLine <= model.getLineCount()
    ) {
        return {
            startLine: fence.startLine,
            endLine: null,
        }
    }

    return null
}

function getSelectedLineRange (selection: monaco.Selection): { startLine: number; endLine: number } {
    let endLine = selection.endLineNumber
    if (!selection.isEmpty() && selection.endColumn === 1 && endLine > selection.startLineNumber) {
        endLine--
    }
    return {
        startLine: selection.startLineNumber,
        endLine,
    }
}

function toggleHashComment (
    editor: monaco.editor.IStandaloneCodeEditor,
    model: monaco.editor.ITextModel,
    selection: monaco.Selection,
): void {
    const { startLine, endLine } = getSelectedLineRange(selection)
    const lines = Array.from(
        { length: endLine - startLine + 1 },
        (_, index) => model.getLineContent(startLine + index),
    )
    const nonBlankLines = lines.filter(line => line.trim().length > 0)
    const shouldUncomment = nonBlankLines.length > 0
        && nonBlankLines.every(line => /^\s*# ?/.test(line))

    const newText = lines.map(line => {
        if (!line.trim()) {
            return line
        }
        if (shouldUncomment) {
            return line.replace(/^(\s*)# ?/, '$1')
        }
        return line.replace(/^(\s*)/, '$1# ')
    }).join('\n')

    editor.executeEdits('toggle-hash-comment', [{
        range: new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)),
        text: newText,
        forceMoveMarkers: true,
    }])

    editor.setSelection(selection)
}

/** Toggle the appropriate comment style for the current Markdown/code-block context. */
export function toggleSmartComment (
    editor: monaco.editor.IStandaloneCodeEditor,
    settings: CodeBlockRunSettings,
): void {
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || !model) {
        return
    }

    const { startLine, endLine } = getSelectedLineRange(selection)
    const scriptFence = findScriptFenceForRange(model, startLine, endLine, settings)
    if (scriptFence) {
        toggleHashComment(editor, model, selection)
        return
    }

    toggleMarkdownComment(editor)
}

/** Toggle fenced code block markers around the current line/selection. */
export function toggleCodeFence (editor: monaco.editor.IStandaloneCodeEditor): void {
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || !model) {
        return
    }

    const { startLine, endLine } = getSelectedLineRange(selection)
    const fence = findCodeFenceForRange(model, startLine, endLine)
    if (fence) {
        const contentEndLine = (fence.endLine ?? model.getLineCount()) - 1
        const innerText = contentEndLine >= fence.startLine + 1
            ? model.getValueInRange(new monaco.Range(
                fence.startLine + 1,
                1,
                contentEndLine,
                model.getLineMaxColumn(contentEndLine),
            ))
            : ''

        const replaceEndLine = fence.endLine ?? model.getLineCount()
        editor.executeEdits('toggle-code-fence', [{
            range: new monaco.Range(fence.startLine, 1, replaceEndLine, model.getLineMaxColumn(replaceEndLine)),
            text: innerText,
            forceMoveMarkers: true,
        }])
        return
    }

    const lines = Array.from(
        { length: endLine - startLine + 1 },
        (_, index) => model.getLineContent(startLine + index),
    )
    const indent = lines[0]?.match(/^\s*/)?.[0] ?? ''
    const newText = `${indent}\`\`\`\n${lines.join('\n')}\n${indent}\`\`\``

    editor.executeEdits('toggle-code-fence', [{
        range: new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)),
        text: newText,
        forceMoveMarkers: true,
    }])

    editor.setSelection(new monaco.Selection(
        startLine + 1,
        selection.startColumn,
        endLine + 1,
        selection.isEmpty() ? selection.startColumn : selection.endColumn,
    ))
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

function getSingleLineCommentInnerBounds (line: string): { innerStart: number; innerEnd: number } | null {
    const openIdx = line.indexOf('<!--')
    const closeIdx = line.lastIndexOf('-->')
    if (openIdx < 0 || closeIdx <= openIdx) {
        return null
    }

    let innerStart = openIdx + 4
    while (innerStart < closeIdx && line[innerStart] === ' ') {
        innerStart++
    }

    let innerEnd = closeIdx
    while (innerEnd > innerStart && line[innerEnd - 1] === ' ') {
        innerEnd--
    }

    return { innerStart, innerEnd }
}

function computeWrapCursor (
    startLine: number,
    originalLines: string[],
): monaco.Selection {
    const indent = originalLines[0].match(/^\s*/)?.[0] ?? ''

    if (originalLines.length === 1) {
        const column = indent.length + '<!-- '.length + 1
        return new monaco.Selection(startLine, column, startLine, column)
    }

    const firstLine = originalLines[0]
    return new monaco.Selection(
        startLine + 1,
        firstLine.length + 1,
        startLine + 1,
        firstLine.length + 1,
    )
}

/**
 * Split a single-line `<!-- -->` comment at the cursor into a multiline block.
 * Returns true when the edit was applied.
 */
export function splitMarkdownCommentNewline (editor: monaco.editor.IStandaloneCodeEditor): boolean {
    const position = editor.getPosition()
    const model = editor.getModel()
    if (!position || !model) {
        return false
    }

    const lineNumber = position.lineNumber
    const lineContent = model.getLineContent(lineNumber)
    if (getMarkdownCommentWrap([lineContent]) !== 'single') {
        return false
    }

    const bounds = getSingleLineCommentInnerBounds(lineContent)
    if (!bounds) {
        return false
    }

    const cursorOffset = position.column - 1
    if (cursorOffset < bounds.innerStart || cursorOffset > bounds.innerEnd) {
        return false
    }

    const indent = lineContent.match(/^\s*/)?.[0] ?? ''
    const before = lineContent.slice(bounds.innerStart, cursorOffset)
    const after = lineContent.slice(cursorOffset, bounds.innerEnd)
    const newText = `${indent}<!--\n${indent}${before}\n${indent}${after}\n${indent}-->`

    editor.executeEdits('split-markdown-comment', [{
        range: new monaco.Range(lineNumber, 1, lineNumber, lineContent.length + 1),
        text: newText,
        forceMoveMarkers: true,
    }])

    const cursorLine = lineNumber + 2
    const cursorColumn = indent.length + 1
    editor.setSelection(new monaco.Selection(cursorLine, cursorColumn, cursorLine, cursorColumn))
    return true
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

    const isWrapping = wrapKind === null

    editor.executeEdits('toggle-markdown-comment', [{
        range: editRange,
        text: newText,
        forceMoveMarkers: true,
    }])

    if (isWrapping) {
        editor.setSelection(computeWrapCursor(startLine, lines))
    }
}
