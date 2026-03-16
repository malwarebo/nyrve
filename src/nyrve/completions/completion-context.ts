/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveEditorBridge } from '../context/editor-bridge.js';
import { INyrveProjectDNA } from '../memory/project-dna.js';
import { TriggerKind } from './completion-trigger.js';

// --- Types ---

export interface CompletionRequest {
	readonly filePath: string;
	readonly language: string;
	readonly fileContent: string;

	readonly cursorLine: number;
	readonly cursorColumn: number;

	readonly prefix: string;
	readonly suffix: string;

	readonly linesBefore: string[];
	readonly linesAfter: string[];

	readonly openTabs: TabContext[];
	readonly recentEdits: RecentEdit[];
	readonly imports: string[];

	readonly conventions: string[];
	readonly patterns: string[];

	readonly triggerKind: TriggerKind;
	readonly requestId: string;
}

export interface TabContext {
	readonly path: string;
	readonly language: string;
	readonly symbols: string[];
	readonly summary: string;
}

export interface RecentEdit {
	readonly line: number;
	readonly oldText: string;
	readonly newText: string;
	readonly timestamp: number;
}

export interface CompletionPrompt {
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly estimatedTokens: number;
}

// --- Service Interface ---

export const INyrveCompletionContext = createDecorator<INyrveCompletionContext>('nyrveCompletionContext');

export interface INyrveCompletionContext {
	readonly _serviceBrand: undefined;

	/** Build a CompletionRequest from current editor state. */
	buildRequest(triggerKind: TriggerKind): CompletionRequest | undefined;

	/** Assemble the prompt for the API call. */
	buildPrompt(request: CompletionRequest): CompletionPrompt;

	/** Record a recent edit for context tracking. */
	recordEdit(line: number, oldText: string, newText: string): void;
}

// --- Constants ---

const LINES_BEFORE = 50;
const LINES_AFTER = 20;
const MAX_RECENT_EDITS = 5;
const MAX_TAB_SYMBOLS = 10;

const COMPLETION_SYSTEM_PROMPT = `You are an inline code completion engine. Output ONLY the code that should be inserted at the cursor position. No explanations, no markdown, no backticks.

Rules:
- Continue the code naturally from the cursor position
- Match the existing code style exactly (indentation, naming, formatting)
- Prefer short, focused completions (1-3 lines for typical, up to 10 for function bodies)
- If completing a function body, include the full implementation
- If completing an if/for/while, include the body
- Stop at a natural boundary (end of statement, end of function, end of block)
- Respect the project conventions listed below`;

// --- Service Implementation ---

export class NyrveCompletionContextService extends Disposable implements INyrveCompletionContext {
	declare readonly _serviceBrand: undefined;

	private _recentEdits: RecentEdit[] = [];

	constructor(
		@INyrveEditorBridge private readonly editorBridge: INyrveEditorBridge,
		@INyrveProjectDNA private readonly projectDNA: INyrveProjectDNA,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	buildRequest(triggerKind: TriggerKind): CompletionRequest | undefined {
		const state = this.editorBridge.getEditorState();
		if (!state.activeFilePath || !state.cursorPosition) {
			return undefined;
		}

		const fileContent = this.editorBridge.getActiveFileContent();
		if (!fileContent) {
			return undefined;
		}

		const lines = fileContent.split('\n');
		const cursorLine = state.cursorPosition.line;
		const cursorColumn = state.cursorPosition.column;

		// Current line text
		const currentLine = lines[cursorLine - 1] ?? '';
		const prefix = currentLine.slice(0, cursorColumn - 1);
		const suffix = currentLine.slice(cursorColumn - 1);

		// Surrounding lines
		const linesBefore = lines.slice(Math.max(0, cursorLine - 1 - LINES_BEFORE), cursorLine - 1);
		const linesAfter = lines.slice(cursorLine, cursorLine + LINES_AFTER);

		// Import statements
		const imports = this._extractImports(lines);

		// Open tab context
		const openTabs = this._buildTabContext(state.openTabs, state.activeFilePath);

		// Project conventions
		const useProjectContext = this.configurationService.getValue<boolean>('nyrve.completions.useProjectContext') ?? true;
		const { conventions, patterns } = useProjectContext ? this._getProjectContext() : { conventions: [], patterns: [] };

		return {
			filePath: state.activeFilePath,
			language: state.activeFileLanguage ?? 'plaintext',
			fileContent,
			cursorLine,
			cursorColumn,
			prefix,
			suffix,
			linesBefore,
			linesAfter,
			openTabs,
			recentEdits: [...this._recentEdits],
			imports,
			conventions,
			patterns,
			triggerKind,
			requestId: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
		};
	}

	buildPrompt(request: CompletionRequest): CompletionPrompt {
		const parts: string[] = [];

		// System prompt with conventions
		let systemPrompt = COMPLETION_SYSTEM_PROMPT;
		if (request.conventions.length > 0) {
			systemPrompt += `\n\nProject conventions:\n${request.conventions.map(c => `- ${c}`).join('\n')}`;
		}

		// User prompt: surrounding code with cursor marker
		parts.push(`File: ${request.filePath} (${request.language})`);
		parts.push('');

		// Imports (if any)
		if (request.imports.length > 0) {
			parts.push('File imports:');
			parts.push(request.imports.join('\n'));
			parts.push('');
		}

		// Recent edits (if any)
		if (request.recentEdits.length > 0) {
			parts.push('Recent edits in this file:');
			for (const edit of request.recentEdits.slice(-3)) {
				if (edit.oldText !== edit.newText) {
					parts.push(`  Line ${edit.line}: "${edit.oldText}" → "${edit.newText}"`);
				}
			}
			parts.push('');
		}

		// Code context with cursor marker
		parts.push('Code context:');
		parts.push('```');

		for (const line of request.linesBefore.slice(-30)) {
			parts.push(line);
		}

		// Current line with cursor marker
		// allow-any-unicode-next-line
		parts.push(request.prefix + '\u2588' + request.suffix);

		for (const line of request.linesAfter.slice(0, 10)) {
			parts.push(line);
		}

		parts.push('```');
		parts.push('');
		// allow-any-unicode-next-line
		parts.push('Complete the code at the \u2588 cursor position:');

		const userPrompt = parts.join('\n');
		const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);

		this.logService.trace(`[Nyrve] Completion context: ~${estimatedTokens} tokens`);

		return { systemPrompt, userPrompt, estimatedTokens };
	}

	recordEdit(line: number, oldText: string, newText: string): void {
		this._recentEdits.push({
			line,
			oldText,
			newText,
			timestamp: Date.now(),
		});

		// Keep only recent edits
		if (this._recentEdits.length > MAX_RECENT_EDITS) {
			this._recentEdits = this._recentEdits.slice(-MAX_RECENT_EDITS);
		}
	}

	private _extractImports(lines: string[]): string[] {
		const imports: string[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith('import ') || trimmed.startsWith('from ') ||
				trimmed.startsWith('require(') || trimmed.startsWith('const ') && trimmed.includes('require(')) {
				imports.push(trimmed);
			}
			// Python imports
			if (trimmed.startsWith('from ') || (trimmed.startsWith('import ') && !trimmed.includes('{'))) {
				if (!imports.includes(trimmed)) {
					imports.push(trimmed);
				}
			}
			// Stop scanning after first non-import, non-blank line
			if (trimmed.length > 0 && !trimmed.startsWith('import') && !trimmed.startsWith('from') &&
				!trimmed.startsWith('require') && !trimmed.startsWith('//') && !trimmed.startsWith('#') &&
				!trimmed.startsWith('/*') && !trimmed.startsWith('*') && !trimmed.startsWith('const ') &&
				!trimmed.startsWith('use ') && !trimmed.startsWith('package ')) {
				break;
			}
		}
		return imports;
	}

	private _buildTabContext(openTabs: readonly string[], activeFilePath: string): TabContext[] {
		const tabs: TabContext[] = [];

		for (const tabPath of openTabs) {
			if (tabPath === activeFilePath) {
				continue;
			}

			const symbols = this.editorBridge.getFileContent(tabPath);
			if (!symbols) {
				continue;
			}

			// Extract exported symbols (simplified)
			const exported = this._extractExportedSymbols(symbols);
			if (exported.length === 0) {
				continue;
			}

			const ext = tabPath.split('.').pop() ?? '';
			tabs.push({
				path: tabPath,
				language: ext,
				symbols: exported.slice(0, MAX_TAB_SYMBOLS),
				summary: `Exports: ${exported.slice(0, 5).join(', ')}`,
			});

			if (tabs.length >= 3) {
				break;
			}
		}

		return tabs;
	}

	private _extractExportedSymbols(content: string): string[] {
		const symbols: string[] = [];
		const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
		let match;
		while ((match = exportRegex.exec(content)) !== null) {
			symbols.push(match[1]);
		}
		return symbols;
	}

	private _getProjectContext(): { conventions: string[]; patterns: string[] } {
		const dna = this.projectDNA.getDNA();
		if (!dna) {
			return { conventions: [], patterns: [] };
		}

		const conventions = dna.conventions
			.slice(0, 5)
			.map(c => `${c.name}: ${c.rule}`);

		const patterns = dna.patterns
			.slice(0, 3)
			.map(p => `${p.name}: ${p.description}`);

		return { conventions, patterns };
	}
}

registerSingleton(INyrveCompletionContext, NyrveCompletionContextService, InstantiationType.Delayed);
