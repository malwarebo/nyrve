/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { CompletionRequest } from './completion-context.js';

// --- Types ---

export interface PostProcessedCompletion {
	readonly text: string;
	/** Whether the text was modified during post-processing. */
	readonly modified: boolean;
	/** Reasons for modifications. */
	readonly modifications: string[];
}

// --- Service Interface ---

export const IForgeCompletionPostProcessor = createDecorator<IForgeCompletionPostProcessor>('forgeCompletionPostProcessor');

export interface IForgeCompletionPostProcessor {
	readonly _serviceBrand: undefined;

	/** Post-process a raw completion text. */
	process(rawText: string, request: CompletionRequest): PostProcessedCompletion;
}

// --- Constants ---

const MAX_COMPLETION_LINES = 15;
const MAX_COMPLETION_CHARS = 2000;

// Markdown fences and backtick patterns
const MARKDOWN_FENCE_REGEX = /^```\w*\n?/;
const TRAILING_FENCE_REGEX = /\n?```\s*$/;

// Natural code boundaries for trimming
const STATEMENT_TERMINATORS = [';', '{', '}', ')', ']'];
const BLOCK_ENDERS = /^[\t ]*[}\])][\s;]*$/;

// --- Implementation ---

export class ForgeCompletionPostProcessor extends Disposable implements IForgeCompletionPostProcessor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService _logService: ILogService,
	) {
		super();
	}

	process(rawText: string, request: CompletionRequest): PostProcessedCompletion {
		const modifications: string[] = [];
		let text = rawText;

		// Step 1: Strip markdown fences
		text = this._stripMarkdown(text, modifications);

		// Step 2: Trim to natural boundary
		text = this._trimToNaturalBoundary(text, modifications);

		// Step 3: Match indentation
		text = this._matchIndentation(text, request, modifications);

		// Step 4: Deduplicate suffix overlap
		text = this._deduplicateSuffix(text, request, modifications);

		// Step 5: Length limit
		text = this._enforceLimit(text, modifications);

		// Step 6: Final cleanup
		text = this._cleanup(text, modifications);

		if (text.trim().length === 0) {
			return { text: '', modified: true, modifications: ['empty after processing'] };
		}

		return {
			text,
			modified: modifications.length > 0,
			modifications,
		};
	}

	/** Strip markdown code fences if the model wrapped its response. */
	private _stripMarkdown(text: string, modifications: string[]): string {
		let result = text;

		if (MARKDOWN_FENCE_REGEX.test(result)) {
			result = result.replace(MARKDOWN_FENCE_REGEX, '');
			modifications.push('stripped leading fence');
		}

		if (TRAILING_FENCE_REGEX.test(result)) {
			result = result.replace(TRAILING_FENCE_REGEX, '');
			modifications.push('stripped trailing fence');
		}

		return result;
	}

	/** Trim completion to a natural code boundary (end of statement, block, etc.). */
	private _trimToNaturalBoundary(text: string, modifications: string[]): string {
		const lines = text.split('\n');

		if (lines.length <= 1) {
			return text;
		}

		// Find the last line that ends at a natural boundary
		let lastGoodLine = lines.length - 1;

		// If the last line is incomplete (no terminator), trim it
		const lastLine = lines[lastGoodLine].trim();
		if (lastLine.length > 0 && !this._endsAtBoundary(lastLine)) {
			// Walk backwards to find a good stopping point
			for (let i = lines.length - 1; i >= 0; i--) {
				const trimmed = lines[i].trim();
				if (trimmed.length === 0 || this._endsAtBoundary(trimmed) || BLOCK_ENDERS.test(lines[i])) {
					lastGoodLine = i;
					break;
				}
			}

			if (lastGoodLine < lines.length - 1) {
				const trimmed = lines.slice(0, lastGoodLine + 1).join('\n');
				modifications.push('trimmed to natural boundary');
				return trimmed;
			}
		}

		return text;
	}

	/** Match the indentation of the completion to the cursor context. */
	private _matchIndentation(text: string, request: CompletionRequest, modifications: string[]): string {
		if (!text.includes('\n')) {
			// Single line — no indentation adjustment needed
			return text;
		}

		// Detect current line's indentation
		const currentLineIndent = this._getIndentation(request.prefix);
		const lines = text.split('\n');

		// Check if the first line already starts with the right indentation
		// (first line is appended to the current line, so it shouldn't have leading indent)
		// Only adjust subsequent lines if they seem off
		if (lines.length > 1) {
			const firstContentLine = lines.find((l, i) => i > 0 && l.trim().length > 0);
			if (firstContentLine) {
				const firstIndent = this._getIndentation(firstContentLine);
				const useTabs = currentLineIndent.includes('\t');
				const tabSize = this.configurationService.getValue<number>('editor.tabSize') ?? 4;

				// Compute expected indent level (current + 1 for block contents, or same level)
				const currentLevel = this._indentLevel(currentLineIndent, useTabs, tabSize);
				const completionLevel = this._indentLevel(firstIndent, useTabs, tabSize);

				if (completionLevel !== currentLevel && completionLevel !== currentLevel + 1) {
					// Re-indent: shift all lines after the first to match
					const delta = (currentLevel + 1) - completionLevel;
					const reindented = lines.map((line, i) => {
						if (i === 0 || line.trim().length === 0) {
							return line;
						}
						return this._adjustIndent(line, delta, useTabs, tabSize);
					});
					modifications.push('adjusted indentation');
					return reindented.join('\n');
				}
			}
		}

		return text;
	}

	/** Remove overlap between the completion text and the suffix after the cursor. */
	private _deduplicateSuffix(text: string, request: CompletionRequest, modifications: string[]): string {
		const suffix = request.suffix.trim();
		if (suffix.length === 0) {
			return text;
		}

		// Check if the end of the completion overlaps with the suffix
		const trimmedText = text.trimEnd();
		for (let overlapLen = Math.min(suffix.length, trimmedText.length); overlapLen > 0; overlapLen--) {
			const textEnd = trimmedText.slice(-overlapLen);
			const suffixStart = suffix.slice(0, overlapLen);
			if (textEnd === suffixStart) {
				modifications.push('deduplicated suffix');
				return trimmedText.slice(0, -overlapLen);
			}
		}

		return text;
	}

	/** Enforce line and character limits. */
	private _enforceLimit(text: string, modifications: string[]): string {
		const maxLines = this.configurationService.getValue<number>('forge.completions.maxLines') ?? MAX_COMPLETION_LINES;
		const lines = text.split('\n');

		if (lines.length > maxLines) {
			// Try to find a natural boundary within the limit
			let cutoff = maxLines;
			for (let i = maxLines - 1; i >= Math.max(0, maxLines - 3); i--) {
				const trimmed = lines[i].trim();
				if (trimmed.length === 0 || this._endsAtBoundary(trimmed) || BLOCK_ENDERS.test(lines[i])) {
					cutoff = i + 1;
					break;
				}
			}
			text = lines.slice(0, cutoff).join('\n');
			modifications.push('truncated to line limit');
		}

		if (text.length > MAX_COMPLETION_CHARS) {
			text = text.slice(0, MAX_COMPLETION_CHARS);
			modifications.push('truncated to char limit');
		}

		return text;
	}

	/** Final cleanup: remove trailing whitespace, ensure no leading newline. */
	private _cleanup(text: string, modifications: string[]): string {
		let result = text;

		// Remove leading newline (completion continues from cursor)
		if (result.startsWith('\n')) {
			result = result.slice(1);
			modifications.push('removed leading newline');
		}

		// Remove excessive trailing whitespace but keep single trailing newline if block-complete
		result = result.replace(/\n{3,}/g, '\n\n');

		// Remove trailing whitespace on each line
		result = result.split('\n').map(l => l.trimEnd()).join('\n');

		// Remove trailing newlines
		result = result.replace(/\n+$/, '');

		return result;
	}

	private _endsAtBoundary(line: string): boolean {
		const lastChar = line.charAt(line.length - 1);
		return STATEMENT_TERMINATORS.includes(lastChar);
	}

	private _getIndentation(line: string): string {
		const match = line.match(/^[\t ]*/);
		return match ? match[0] : '';
	}

	private _indentLevel(indent: string, useTabs: boolean, tabSize: number): number {
		if (useTabs) {
			return indent.split('\t').length - 1;
		}
		return Math.floor(indent.length / tabSize);
	}

	private _adjustIndent(line: string, delta: number, useTabs: boolean, tabSize: number): string {
		const currentIndent = this._getIndentation(line);
		const content = line.slice(currentIndent.length);
		const currentLevel = this._indentLevel(currentIndent, useTabs, tabSize);
		const newLevel = Math.max(0, currentLevel + delta);
		const unit = useTabs ? '\t' : ' '.repeat(tabSize);
		return unit.repeat(newLevel) + content;
	}
}

registerSingleton(IForgeCompletionPostProcessor, ForgeCompletionPostProcessor, InstantiationType.Delayed);
