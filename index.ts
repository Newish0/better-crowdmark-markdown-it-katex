/**
 * Fork of `vscode-markdown-it-katex`
 *
 * Modified to parse Katex in chrome extension service worker.
 *
 */

// TODO: Turn this into an actual fork and add as submodule to repo

import type * as StateBlock from "markdown-it/lib/rules_block/state_block";
import type StateCore from "markdown-it/lib/rules_core/state_core";
import type * as StateInline from "markdown-it/lib/rules_inline/state_inline";
import type * as Token from "markdown-it/lib/token";
import { MarkdownKatexOptions } from "./types";
import { katexToHtml } from "@/services/katex";

type RenderKatexFunction = () => Promise<void>;
const batch: RenderKatexFunction[] = [];

export async function renderBatch() {
    await Promise.all(batch.map((r) => r()));
    batch.splice(0, batch.length);
}

/**
 * Create a function that will render the given latex.
 * @param latex
 * @param options
 * @returns
 */
function createRenderFunc(
    latex: string,
    options?: katex.KatexOptions
): [string, RenderKatexFunction] {
    const elnId = `KM-${crypto.randomUUID()}`;
    const placeholder = `<span id="${elnId}">Katex Placeholder - <code>renderBatch</code> to resolve.</span>`;
    return [
        placeholder,
        async () => {
            const html = await katexToHtml(latex, options);
            const placeholder = document.querySelector(`#${elnId}`);
            if (!placeholder)
                throw new Error(
                    `Failed to render latex at placeholder ${elnId}. Cannot find in DOM.`
                );
            placeholder.innerHTML = html;
            placeholder.parentElement?.append(...placeholder.children);
            placeholder.remove();
        },
    ] as const;
}

/**
 * Test if potential opening or closing delimiter
 */
function isValidInlineDelim(
    state: StateInline,
    pos: number
): { can_open: boolean; can_close: boolean } {
    const prevChar = state.src[pos - 1];
    const char = state.src[pos];
    const nextChar = state.src[pos + 1];

    if (char !== "$") {
        return { can_open: false, can_close: false };
    }

    let canOpen = false;
    let canClose = false;
    if (
        prevChar !== "$" &&
        prevChar !== "\\" &&
        (prevChar === undefined || isWhitespace(prevChar) || !isWordCharacterOrNumber(prevChar))
    ) {
        canOpen = true;
    }

    if (
        nextChar !== "$" &&
        (nextChar == undefined || isWhitespace(nextChar) || !isWordCharacterOrNumber(nextChar))
    ) {
        canClose = true;
    }

    return { can_open: canOpen, can_close: canClose };
}

function isWhitespace(char: string): boolean {
    return /^\s$/u.test(char);
}

function isWordCharacterOrNumber(char: string): boolean {
    return /^[\w\d]$/u.test(char);
}

function isValidBlockDelim(
    state: StateInline,
    pos: number
): { readonly can_open: boolean; readonly can_close: boolean } {
    const prevChar = state.src[pos - 1];
    const char = state.src[pos];
    const nextChar = state.src[pos + 1];
    const nextCharPlus1 = state.src[pos + 2];

    if (
        char === "$" &&
        prevChar !== "$" &&
        prevChar !== "\\" &&
        nextChar === "$" &&
        nextCharPlus1 !== "$"
    ) {
        return { can_open: true, can_close: true };
    }

    return { can_open: false, can_close: false };
}

function inlineMath(state: StateInline, silent: boolean): boolean {
    if (state.src[state.pos] !== "$") {
        return false;
    }

    const lastToken = state.tokens.at(-1);
    if (lastToken?.type === "html_inline") {
        // We may be inside of inside of inline html
        if (/^<\w+.+[^/]>$/.test(lastToken.content)) {
            return false;
        }
    }

    let res = isValidInlineDelim(state, state.pos);
    if (!res.can_open) {
        if (!silent) {
            state.pending += "$";
        }
        state.pos += 1;
        return true;
    }

    // First check for and bypass all properly escaped delimieters
    // This loop will assume that the first leading backtick can not
    // be the first character in state.src, which is known since
    // we have found an opening delimieter already.
    let start = state.pos + 1;
    let match = start;
    let pos;
    while ((match = state.src.indexOf("$", match)) !== -1) {
        // Found potential $, look for escapes, pos will point to
        // first non escape when complete
        pos = match - 1;
        while (state.src[pos] === "\\") {
            pos -= 1;
        }

        // Even number of escapes, potential closing delimiter found
        if ((match - pos) % 2 == 1) {
            break;
        }
        match += 1;
    }

    // No closing delimter found.  Consume $ and continue.
    if (match === -1) {
        if (!silent) {
            state.pending += "$";
        }
        state.pos = start;
        return true;
    }

    // Check if we have empty content, ie: $$.  Do not parse.
    if (match - start === 0) {
        if (!silent) {
            state.pending += "$$";
        }
        state.pos = start + 1;
        return true;
    }

    // Check for valid closing delimiter
    res = isValidInlineDelim(state, match);
    if (!res.can_close) {
        if (!silent) {
            state.pending += "$";
        }
        state.pos = start;
        return true;
    }

    if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.markup = "$";
        token.content = state.src.slice(start, match);
    }

    state.pos = match + 1;
    return true;
}

function blockMath(state: StateBlock, start: number, end: number, silent: boolean): boolean {
    var lastLine,
        next,
        lastPos,
        found = false,
        token,
        pos = state.bMarks[start] + state.tShift[start],
        max = state.eMarks[start];

    if (pos + 2 > max) {
        return false;
    }
    if (state.src.slice(pos, pos + 2) !== "$$") {
        return false;
    }

    pos += 2;
    let firstLine = state.src.slice(pos, max);

    if (silent) {
        return true;
    }
    if (firstLine.trim().slice(-2) === "$$") {
        // Single line expression
        firstLine = firstLine.trim().slice(0, -2);
        found = true;
    }

    for (next = start; !found; ) {
        next++;

        if (next >= end) {
            break;
        }

        pos = state.bMarks[next] + state.tShift[next];
        max = state.eMarks[next];

        if (pos < max && state.tShift[next] < state.blkIndent) {
            // non-empty line with negative indent should stop the list:
            break;
        }

        if (state.src.slice(pos, max).trim().slice(-2) === "$$") {
            lastPos = state.src.slice(0, max).lastIndexOf("$$");
            lastLine = state.src.slice(pos, lastPos);
            found = true;
        } else if (state.src.slice(pos, max).trim().includes("$$")) {
            lastPos = state.src.slice(0, max).trim().indexOf("$$");
            lastLine = state.src.slice(pos, lastPos);
            found = true;
        }
    }

    state.line = next + 1;

    token = state.push("math_block", "math", 0);
    token.block = true;
    token.content =
        (firstLine && firstLine.trim() ? firstLine + "\n" : "") +
        state.getLines(start + 1, next, state.tShift[start], true) +
        (lastLine && lastLine.trim() ? lastLine : "");
    token.map = [start, state.line];
    token.markup = "$$";
    return true;
}

function blockBareMath(state: StateBlock, start: number, end: number, silent: boolean): boolean {
    var lastLine,
        found = false,
        pos = state.bMarks[start] + state.tShift[start],
        max = state.eMarks[start];

    const firstLine = state.src.slice(pos, max);

    if (!/^\s*\\begin/.test(firstLine)) {
        return false;
    }

    if (start > 0) {
        // Previous line must be blank for bare blocks
        const previousStart = state.bMarks[start - 1] + state.tShift[start - 1];
        const previousEnd = state.eMarks[start - 1];
        const previousLine = state.src.slice(previousStart, previousEnd);
        if (!/^\s*$/.test(previousLine)) {
            return false;
        }
    }

    if (silent) {
        return true;
    }

    // Handle Single line code block
    let next = start;
    if (!/\\end[\{\}\w]*\s*$/.test(firstLine)) {
        let nestingCount = 0;
        for (; !found; ) {
            next++;
            if (next >= end) {
                break;
            }

            pos = state.bMarks[next] + state.tShift[next];
            max = state.eMarks[next];

            if (pos < max && state.tShift[next] < state.blkIndent) {
                // non-empty line with negative indent should stop the list:
                break;
            }
            const line = state.src.slice(pos, max);
            for (const match of line.matchAll(/\\begin|\\end/g)) {
                if (match[0] === "\\begin") {
                    ++nestingCount;
                } else if (match[0] === "\\end") {
                    --nestingCount;
                    if (nestingCount < 0) {
                        const lastPos = max;
                        lastLine = state.src.slice(pos, lastPos);
                        found = true;
                    }
                }
            }
        }
    }

    state.line = next + 1;

    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.content =
        (firstLine && firstLine.trim() ? firstLine + "\n" : "") +
        state.getLines(start + 1, next, state.tShift[start], true) +
        (lastLine && lastLine.trim() ? lastLine : "");
    token.map = [start, state.line];
    token.markup = "$$";
    return true;
}

function inlineMathBlock(state: StateInline, silent: boolean): boolean {
    var start, match, token, res, pos;

    if (state.src.slice(state.pos, state.pos + 2) !== "$$") {
        return false;
    }

    res = isValidBlockDelim(state, state.pos);
    if (!res.can_open) {
        if (!silent) {
            state.pending += "$$";
        }
        state.pos += 2;
        return true;
    }

    // First check for and bypass all properly escaped delimieters
    // This loop will assume that the first leading backtick can not
    // be the first character in state.src, which is known since
    // we have found an opening delimieter already.
    start = state.pos + 2;
    match = start;
    while ((match = state.src.indexOf("$$", match)) !== -1) {
        // Found potential $$, look for escapes, pos will point to
        // first non escape when complete
        pos = match - 1;
        while (state.src[pos] === "\\") {
            pos -= 1;
        }

        // Even number of escapes, potential closing delimiter found
        if ((match - pos) % 2 == 1) {
            break;
        }
        match += 2;
    }

    // No closing delimter found.  Consume $$ and continue.
    if (match === -1) {
        if (!silent) {
            state.pending += "$$";
        }
        state.pos = start;
        return true;
    }

    // Check if we have empty content, ie: $$$$.  Do not parse.
    if (match - start === 0) {
        if (!silent) {
            state.pending += "$$$$";
        }
        state.pos = start + 2;
        return true;
    }

    // Check for valid closing delimiter
    res = isValidBlockDelim(state, match);
    if (!res.can_close) {
        if (!silent) {
            state.pending += "$$";
        }
        state.pos = start;
        return true;
    }

    if (!silent) {
        token = state.push("math_block", "math", 0);
        token.block = true;
        token.markup = "$$";
        token.content = state.src.slice(start, match);
    }

    state.pos = match + 2;
    return true;
}

function inlineBareBlock(state: StateInline, silent: boolean): boolean {
    const text = state.src.slice(state.pos);
    if (!/^\n\\begin/.test(text)) {
        return false;
    }
    state.pos += 1;

    if (silent) {
        return true;
    }

    const lines = text.split(/\n/g).slice(1);
    const beginRe = /^\\begin/;
    const endRe = /^\\end/;

    let nestingCount = 0;
    let foundLine: number | undefined = undefined;
    for (var i = 0; i < lines.length; ++i) {
        const line = lines[i];
        if (beginRe.test(line)) {
            ++nestingCount;
        } else if (endRe.test(line)) {
            --nestingCount;
            if (nestingCount <= 0) {
                foundLine = i;
                break;
            }
        }
    }

    if (typeof foundLine === "undefined") {
        return false;
    }

    const endIndex =
        lines.slice(0, foundLine + 1).reduce((p, c) => p + c.length, 0) + foundLine + 1;

    if (!silent) {
        const token = state.push("math_inline_bare_block", "math", 0);
        token.block = true;
        token.markup = "$$";
        token.content = text.slice(1, endIndex);
    }

    state.pos = state.pos + endIndex;
    return true;
}

// For any html block that contains math, replace the html block token with new tokens that separate out
// the html blocks from the math
function handleMathInHtml(
    state: StateCore,
    mathType: string,
    mathMarkup: string,
    mathRegex: RegExp
) {
    const tokens = state.tokens;

    for (let index = tokens.length - 1; index >= 0; index--) {
        const currentToken = tokens[index];
        const newTokens: Token[] = [];

        if (currentToken.type !== "html_block") {
            continue;
        }

        const content = currentToken.content;

        // Process for each math referenced within the html block
        for (const match of content.matchAll(mathRegex)) {
            if (!match.groups) {
                continue;
            }

            const html_before_math = match.groups.html_before_math;
            const math = match.groups.math;
            const html_after_math = match.groups.html_after_math;

            if (html_before_math) {
                newTokens.push({
                    ...currentToken,
                    type: "html_block",
                    map: null,
                    content: html_before_math,
                } as Token);
            }

            if (math) {
                newTokens.push({
                    ...currentToken,
                    type: mathType,
                    map: null,
                    content: math,
                    markup: mathMarkup,
                    block: true,
                    tag: "math",
                } as Token);
            }

            if (html_after_math) {
                newTokens.push({
                    ...currentToken,
                    type: "html_block",
                    map: null,
                    content: html_after_math,
                } as Token);
            }
        }

        // Replace the original html_block token with the newly expanded tokens
        if (newTokens.length > 0) {
            tokens.splice(index, 1, ...newTokens);
        }
    }
    return true;
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export default function (md: import("markdown-it"), options?: MarkdownKatexOptions) {
    const enableBareBlocks = options?.enableBareBlocks;
    const enableMathBlockInHtml = options?.enableMathBlockInHtml;
    const enableMathInlineInHtml = options?.enableMathInlineInHtml;

    const katexInline = (latex: string) => {
        const displayMode = /\\begin\{(align|equation|gather|cd|alignat)\}/gi.test(latex);
        try {
            const [placeholder, renderFunc] = createRenderFunc(latex, { ...options, displayMode });
            batch.push(renderFunc);
            return placeholder;
        } catch (error) {
            if (options?.throwOnError) {
                console.log(error);
            }
            return `<span class="katex-error" title="${escapeHtml(latex)}">${escapeHtml(
                error + ""
            )}</span>`;
        }
    };

    const inlineRenderer = (tokens: readonly Token[], idx: number) => {
        return katexInline(tokens[idx].content);
    };

    const katexBlockRenderer = (latex: string) => {
        try {
            const [placeholder, renderFunc] = createRenderFunc(latex, {
                ...options,
                displayMode: true,
            });
            batch.push(renderFunc);

            return `<p class="katex-block">${placeholder}</p>`;
        } catch (error) {
            if (options?.throwOnError) {
                console.log(error);
            }
            return `<p class="katex-block katex-error" title="${escapeHtml(latex)}">${escapeHtml(
                error + ""
            )}</p>`;
        }
    };

    const blockRenderer = (tokens: readonly Token[], idx: number) => {
        return katexBlockRenderer(tokens[idx].content) + "\n";
    };

    md.inline.ruler.after("escape", "math_inline", inlineMath);
    md.inline.ruler.after("escape", "math_inline_block", inlineMathBlock);
    if (enableBareBlocks) {
        md.inline.ruler.before("text", "math_inline_bare_block", inlineBareBlock);
    }

    md.block.ruler.after(
        "blockquote",
        "math_block",
        (state, start, end, silent) => {
            if (enableBareBlocks && blockBareMath(state, start, end, silent)) {
                return true;
            }
            return blockMath(state, start, end, silent);
        },
        {
            alt: ["paragraph", "reference", "blockquote", "list"],
        }
    );

    // Regex to capture any html prior to math block, the math block (single or multi line), and any html after the math block
    const math_block_within_html_regex =
        /(?<html_before_math>[\s\S]*?)\$\$(?<math>[\s\S]+?)\$\$(?<html_after_math>(?:(?!\$\$[\s\S]+?\$\$)[\s\S])*)/gm;

    // Regex to capture any html prior to math inline, the math inline (single line), and any html after the math inline
    const math_inline_within_html_regex =
        /(?<html_before_math>[\s\S]*?)\$(?<math>.*?)\$(?<html_after_math>(?:(?!\$.*?\$)[\s\S])*)/gm;

    if (enableMathBlockInHtml) {
        md.core.ruler.push("math_block_in_html_block", (state) => {
            return handleMathInHtml(state, "math_block", "$$", math_block_within_html_regex);
        });
    }

    if (enableMathInlineInHtml) {
        md.core.ruler.push("math_inline_in_html_block", (state) => {
            return handleMathInHtml(state, "math_inline", "$", math_inline_within_html_regex);
        });
    }

    md.renderer.rules.math_inline = inlineRenderer;
    md.renderer.rules.math_inline_block = blockRenderer;
    md.renderer.rules.math_inline_bare_block = blockRenderer;
    md.renderer.rules.math_block = blockRenderer;
}
