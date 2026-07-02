// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

export interface CommandHistorySuggestion {
    candidates: string[]
    prefix: string
    range: monaco.Range
    signature: string
}

/**
 * Find command lines above the cursor which extend the text currently being typed.
 * Results are de-duplicated with the most recently used command first.
 */
export function findCommandHistorySuggestions (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
): CommandHistorySuggestion | null {
    const line = model.getLineContent(position.lineNumber)
    const beforeCursor = line.slice(0, position.column - 1)
    const afterCursor = line.slice(position.column - 1)
    const indentationLength = beforeCursor.length - beforeCursor.trimStart().length
    const prefix = beforeCursor.slice(indentationLength)

    // Do not offer arbitrary commands on an empty line or replace existing text
    // to the right of the caret. In both cases Tab should retain its indent action.
    if (!prefix || afterCursor.trim()) {
        return null
    }

    const candidates: string[] = []
    const seen = new Set<string>()
    for (let lineNumber = position.lineNumber - 1; lineNumber >= 1; lineNumber--) {
        const candidate = model.getLineContent(lineNumber).trim()
        if (
            candidate.length <= prefix.length ||
            !candidate.startsWith(prefix) ||
            isNonCommandLine(candidate) ||
            seen.has(candidate)
        ) {
            continue
        }
        seen.add(candidate)
        candidates.push(candidate)
    }

    if (!candidates.length) {
        return null
    }

    return {
        candidates,
        prefix,
        range: new monaco.Range(
            position.lineNumber,
            indentationLength + 1,
            position.lineNumber,
            position.column,
        ),
        signature: `${model.uri.toString()}:${position.lineNumber}:${position.column}:${prefix}:${candidates.join('\u0000')}`,
    }
}

function isNonCommandLine (line: string): boolean {
    return line.startsWith('#') ||
        line.startsWith('//') ||
        line.startsWith('/*') ||
        line.startsWith('*') ||
        line.startsWith('<!--') ||
        line.startsWith('-->') ||
        line.startsWith('```')
}
