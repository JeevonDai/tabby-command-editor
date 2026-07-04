// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'
// @ts-ignore - Monaco bundled language definitions
import { language as yamlLanguage } from 'monaco-editor/esm/vs/basic-languages/yaml/yaml.js'
// @ts-ignore - Monaco bundled language definitions
import { language as pythonLanguage } from 'monaco-editor/esm/vs/basic-languages/python/python.js'
// @ts-ignore - Monaco bundled language definitions
import { language as cppLanguage } from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js'
// @ts-ignore - Monaco bundled language definitions
import { language as powershellLanguage } from 'monaco-editor/esm/vs/basic-languages/powershell/powershell.js'
// @ts-ignore - Monaco bundled language definitions
import { language as shellLanguage } from 'monaco-editor/esm/vs/basic-languages/shell/shell.js'

export const COMMAND_EDITOR_LANGUAGE = 'command-editor'
export const COMMAND_EDITOR_THEME_DARK = 'tabby-command-editor-dark'
export const COMMAND_EDITOR_THEME_LIGHT = 'tabby-command-editor-light'

let registered = false

const DARK_TOKEN_RULES: monaco.editor.ITokenThemeRule[] = [
    { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'comment.markdown', foreground: '808080', fontStyle: 'italic' },
    { token: 'string.code-fence', foreground: '808080' },
    { token: 'source.code', foreground: 'D4D4D4' },
    { token: 'markup.heading.1', foreground: '569CD6', fontStyle: 'bold' },
    { token: 'markup.heading.2', foreground: '4FC1FF', fontStyle: 'bold' },
    { token: 'markup.heading.3', foreground: '4EC9B0', fontStyle: 'bold' },
    { token: 'markup.heading.4', foreground: 'C586C0', fontStyle: 'bold' },
    { token: 'markup.heading.5', foreground: 'DCDCAA', fontStyle: 'bold' },
    { token: 'markup.heading.6', foreground: '9CDCFE', fontStyle: 'bold' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'string.escape', foreground: 'D7BA7D' },
    { token: 'string.invalid', foreground: 'F44747' },
    { token: 'keyword', foreground: 'C586C0' },
    { token: 'variable.predefined', foreground: '9CDCFE' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'attribute.name', foreground: '9CDCFE' },
    { token: 'delimiter', foreground: 'D4D4D4' },
]

const LIGHT_TOKEN_RULES: monaco.editor.ITokenThemeRule[] = [
    { token: 'comment', foreground: '008000', fontStyle: 'italic' },
    { token: 'comment.markdown', foreground: '6E7781', fontStyle: 'italic' },
    { token: 'string.code-fence', foreground: '6E7781' },
    { token: 'source.code', foreground: '24292F' },
    { token: 'markup.heading.1', foreground: '0550AE', fontStyle: 'bold' },
    { token: 'markup.heading.2', foreground: '0969DA', fontStyle: 'bold' },
    { token: 'markup.heading.3', foreground: '116329', fontStyle: 'bold' },
    { token: 'markup.heading.4', foreground: '6639BA', fontStyle: 'bold' },
    { token: 'markup.heading.5', foreground: 'BC4C00', fontStyle: 'bold' },
    { token: 'markup.heading.6', foreground: '57606A', fontStyle: 'bold' },
    { token: 'string', foreground: 'A31515' },
    { token: 'string.escape', foreground: '795E26' },
    { token: 'string.invalid', foreground: 'CD3131' },
    { token: 'keyword', foreground: 'AF00DB' },
    { token: 'variable.predefined', foreground: '001080' },
    { token: 'number', foreground: '098658' },
    { token: 'attribute.name', foreground: '001080' },
    { token: 'delimiter', foreground: '393939' },
]

const jsonLanguage: monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenizer: {
        root: [
            [/[{}[\]]/, '@brackets'],
            [/[,:]/, 'delimiter'],
            [/"([^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
            [/"([^"\\]|\\.)*"/, 'string.value'],
            [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
            [/\b(?:true|false|null)\b/, 'keyword'],
            [/\/\/.*$/, 'comment'],
            [/\/\*/, 'comment', '@comment'],
        ],
        comment: [
            [/[^/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[/\*]/, 'comment'],
        ],
    },
}

function registerEmbeddedLanguage (
    id: string,
    language: monaco.languages.IMonarchLanguage,
): void {
    if (!monaco.languages.getLanguages().some(item => item.id === id)) {
        monaco.languages.register({ id })
    }
    monaco.languages.setMonarchTokensProvider(id, language)
}

function registerEmbeddedCodeLanguages (): void {
    registerEmbeddedLanguage('json', jsonLanguage)
    registerEmbeddedLanguage('yaml', yamlLanguage)
    registerEmbeddedLanguage('powershell', powershellLanguage)
    registerEmbeddedLanguage('shell', shellLanguage)
    registerEmbeddedLanguage('python', pythonLanguage)
    registerEmbeddedLanguage('c', cppLanguage)
    registerEmbeddedLanguage('cpp', cppLanguage)
}

export function registerCommandEditorLanguage (): void {
    if (registered) {
        return
    }
    registered = true

    registerEmbeddedCodeLanguages()
    monaco.languages.register({ id: COMMAND_EDITOR_LANGUAGE })

    monaco.languages.setMonarchTokensProvider(COMMAND_EDITOR_LANGUAGE, {
        defaultToken: '',
        ignoreCase: false,
        tokenizer: {
            root: [
                [/^\s*```(?:json|jsonc)\s*$/i, { token: 'string.code-fence', next: '@codeblock', nextEmbedded: 'json' }],
                [/^\s*```(?:yaml|yml)\s*$/i, { token: 'string.code-fence', next: '@codeblock', nextEmbedded: 'yaml' }],
                [/^\s*```(?:powershell|ps1|pwsh)\s*$/i, { token: 'string.code-fence', next: '@codeblock', nextEmbedded: 'powershell' }],
                [/^\s*```(?:bash|sh|shell|zsh)\s*$/i, { token: 'string.code-fence', next: '@codeblock', nextEmbedded: 'shell' }],
                [/^\s*```(?:python|py)\s*$/i, { token: 'string.code-fence', next: '@codeblock', nextEmbedded: 'python' }],
                [/^\s*```(?:c)\s*$/i, { token: 'string.code-fence', next: '@codeblock', nextEmbedded: 'c' }],
                [/^\s*```(?:cpp|c\+\+|cc|cxx|h|hpp)\s*$/i, { token: 'string.code-fence', next: '@codeblock', nextEmbedded: 'cpp' }],
                [/^\s*```[^\s`]*\s*$/, { token: 'string.code-fence', next: '@plainCodeblock' }],
                [/^\s*#(?:\s+.*)?$/, 'markup.heading.1'],
                [/^\s*##(?:\s+.*)?$/, 'markup.heading.2'],
                [/^\s*###(?:\s+.*)?$/, 'markup.heading.3'],
                [/^\s*####(?:\s+.*)?$/, 'markup.heading.4'],
                [/^\s*#####(?:\s+.*)?$/, 'markup.heading.5'],
                [/^\s*######(?:\s+.*)?$/, 'markup.heading.6'],
                [/<!--/, 'comment.markdown', '@markdownComment'],
                [/\/\/.*$/, 'comment'],
                [/\/\*/, 'comment', '@blockComment'],
                [/"([^"\\]|\\.)*$/, 'string.invalid'],
                [/'([^'\\]|\\.)*$/, 'string.invalid'],
                [/"/, 'string', '@stringDouble'],
                [/'/, 'string', '@stringSingle'],
                [/\$\{[^}]*\}/, 'variable.predefined'],
                [/\$[\w@#?*!-]+/, 'variable.predefined'],
                [/[&|;<>]/, 'delimiter'],
                [/\b(?:if|then|else|elif|fi|for|do|done|while|case|esac|function|return|export|local|sudo|kubectl|docker|git|npm|yarn|pnpm|cd|ls|cat|grep|curl|wget|ssh|scp|chmod|chown|mkdir|rm|mv|cp|echo|printf|exit|source|\.)\b/, 'keyword'],
                [/\b-[\w-]+\b/, 'attribute.name'],
                [/\b\d+\b/, 'number'],
            ],
            codeblock: [
                [/^\s*```\s*$/, { token: 'string.code-fence', next: '@pop', nextEmbedded: '@pop' }],
                [/.*$/, ''],
            ],
            plainCodeblock: [
                [/^\s*```\s*$/, { token: 'string.code-fence', next: '@pop' }],
                [/.*$/, 'source.code'],
            ],
            blockComment: [
                [/[^/*]+/, 'comment'],
                [/\*\//, 'comment', '@pop'],
                [/[/\*]/, 'comment'],
            ],
            markdownComment: [
                [/[^<-]+/, 'comment.markdown'],
                [/-->/, 'comment.markdown', '@pop'],
                [/<!--/, 'comment.markdown'],
                [/[<-]/, 'comment.markdown'],
            ],
            stringDouble: [
                [/[^\\"]+/, 'string'],
                [/\\./, 'string.escape'],
                [/"/, 'string', '@pop'],
            ],
            stringSingle: [
                [/[^\\']+/, 'string'],
                [/\\./, 'string.escape'],
                [/'/, 'string', '@pop'],
            ],
        },
    })

    monaco.languages.setLanguageConfiguration(COMMAND_EDITOR_LANGUAGE, {
        comments: {
            lineComment: '//',
            blockComment: ['/*', '*/'],
        },
        brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')'],
        ],
        autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: '\'', close: '\'' },
            { open: '`', close: '`' },
            { open: '/*', close: ' */' },
        ],
    })

    monaco.editor.defineTheme(COMMAND_EDITOR_THEME_DARK, {
        base: 'vs-dark',
        inherit: true,
        rules: DARK_TOKEN_RULES,
        colors: {},
    })

    monaco.editor.defineTheme(COMMAND_EDITOR_THEME_LIGHT, {
        base: 'vs',
        inherit: true,
        rules: LIGHT_TOKEN_RULES,
        colors: {},
    })
}

export function resolveCommandEditorTheme (preferDark: boolean): string {
    return preferDark ? COMMAND_EDITOR_THEME_DARK : COMMAND_EDITOR_THEME_LIGHT
}

export function defineCommandEditorThemeColors (
    preferDark: boolean,
    background: string,
    foreground: string,
): string {
    const name = resolveCommandEditorTheme(preferDark)
    monaco.editor.defineTheme(name, {
        base: preferDark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: preferDark ? DARK_TOKEN_RULES : LIGHT_TOKEN_RULES,
        colors: {
            'editor.background': background,
            'editor.foreground': foreground,
            'editorGutter.background': background,
            'editorStickyScroll.background': background,
        },
    })
    return name
}
