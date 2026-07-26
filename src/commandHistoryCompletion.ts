// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

export interface CommandHistorySuggestion {
    candidates: string[]
    prefix: string
    range: monaco.Range
    signature: string
}

/**
 * Find command lines anywhere in the current file which fuzzily match the text being typed.
 * Results are de-duplicated and ordered by distance from the current line.
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
    const lineNumbers = Array.from(
        { length: model.getLineCount() },
        (_, index) => index + 1,
    )
        .filter(lineNumber => lineNumber !== position.lineNumber)
        .sort((left, right) => {
            const distance = Math.abs(left - position.lineNumber) - Math.abs(right - position.lineNumber)
            return distance || left - right
        })

    for (const lineNumber of lineNumbers) {
        const candidate = model.getLineContent(lineNumber).trim()
        if (
            candidate.length <= prefix.length ||
            !isFuzzyMatch(candidate, prefix) ||
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

/** Case-insensitive subsequence match: `gco` matches `git checkout`. */
export function isFuzzyMatch (candidate: string, query: string): boolean {
    const normalizedCandidate = candidate.toLocaleLowerCase()
    const normalizedQuery = query.toLocaleLowerCase()
    let queryIndex = 0

    for (const character of normalizedCandidate) {
        if (character === normalizedQuery[queryIndex]) {
            queryIndex++
            if (queryIndex === normalizedQuery.length) {
                return true
            }
        }
    }
    return normalizedQuery.length === 0
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
