/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveEditorBridge } from './editor-bridge.js';
import { INyrveMentionResolver } from './mention-resolver.js';
import { INyrveMemoryRetriever, MemoryContext } from '../memory/memory-retriever.js';

// --- Types ---

export type MentionType =
	| 'file' | 'folder' | 'symbol' | 'selection' | 'active' | 'open'
	| 'git-diff' | 'git-staged' | 'git-log' | 'terminal' | 'errors'
	| 'tests' | 'docs' | 'deps' | 'recent' | 'search' | 'url'
	| 'image' | 'project' | 'custom';

/** Resolved @-mention context block sent to the agent. */
export interface ContextBlock {
	type: MentionType;
	source: string;
	content: string;
	tokenCount: number;
	truncated: boolean;
	metadata: {
		language?: string;
		lineRange?: { start: number; end: number };
		lastModified?: string;
	};
}

/** Priority levels for context blocks during budget trimming. */
const enum ContextPriority {
	ExplicitMention = 0,  // Highest — user explicitly requested
	ActiveFile = 1,
	IndexRetrieved = 2,
	AmbientContext = 3,   // Lowest — git status, diagnostics summary
}

export interface ContextBuildResult {
	readonly blocks: readonly ContextBlock[];
	readonly implicitContext: string;
	readonly memoryContext: string;
	readonly totalTokens: number;
	readonly truncatedCount: number;
}

// --- Service Interface ---

export const INyrveContextBuilder = createDecorator<INyrveContextBuilder>('nyrveContextBuilder');

export interface INyrveContextBuilder {
	readonly _serviceBrand: undefined;

	/**
	 * Build the full context for an agent request.
	 * Resolves @-mentions, adds implicit context, applies token budget.
	 */
	buildContext(userMessage: string): Promise<ContextBuildResult>;

	/**
	 * Build only the implicit context (always included, lightweight).
	 * Includes: active file path, cursor position, project root, git branch, error summary.
	 */
	buildImplicitContext(): string;

	/**
	 * Estimate tokens for a string.
	 */
	estimateTokens(text: string): number;
}

// --- Service Implementation ---

export class NyrveContextBuilder extends Disposable implements INyrveContextBuilder {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveMentionResolver private readonly mentionResolver: INyrveMentionResolver,
		@INyrveEditorBridge private readonly editorBridge: INyrveEditorBridge,
		@INyrveMemoryRetriever private readonly memoryRetriever: INyrveMemoryRetriever,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async buildContext(userMessage: string): Promise<ContextBuildResult> {
		const tokenBudget = this.configurationService.getValue<number>('nyrve.context.defaultTokenBudget') ?? 30000;

		// 1. Build implicit context (always included, ~500 tokens)
		const implicitContext = this.buildImplicitContext();
		const implicitTokens = this.estimateTokens(implicitContext);

		// 2. Retrieve deep memory context (separate budget, goes before @-mentions)
		// Order in system prompt: Team Knowledge → Project DNA → Decisions → @-mentions → Editor State
		const memoryContext = await this._retrieveMemoryContext(userMessage);
		const memoryTokens = this.estimateTokens(memoryContext);

		// 3. Resolve explicit @-mentions
		const mentionBlocks = await this.mentionResolver.resolveAll(userMessage);

		// 4. Categorize and prioritize
		const prioritized: Array<{ block: ContextBlock; priority: ContextPriority }> = [];

		for (const block of mentionBlocks) {
			prioritized.push({ block, priority: ContextPriority.ExplicitMention });
		}

		// 5. Apply token budget (memory has its own budget, doesn't compete with @-mentions)
		let remainingBudget = tokenBudget - implicitTokens - memoryTokens;
		const finalBlocks: ContextBlock[] = [];
		let truncatedCount = 0;

		// Sort by priority (lower number = higher priority)
		prioritized.sort((a, b) => a.priority - b.priority);

		for (const { block } of prioritized) {
			if (remainingBudget <= 0) {
				truncatedCount++;
				continue;
			}

			if (block.tokenCount <= remainingBudget) {
				finalBlocks.push(block);
				remainingBudget -= block.tokenCount;
			} else {
				// Truncate this block to fit remaining budget
				const truncatedContent = this._truncateToTokenBudget(block.content, remainingBudget);
				finalBlocks.push({
					...block,
					content: truncatedContent,
					tokenCount: remainingBudget,
					truncated: true,
				});
				remainingBudget = 0;
				truncatedCount++;
			}
		}

		const totalTokens = implicitTokens + memoryTokens + finalBlocks.reduce((sum, b) => sum + b.tokenCount, 0);

		this.logService.trace(
			`[Nyrve] Context built: ${finalBlocks.length} blocks, ${totalTokens} tokens ` +
			`(memory: ${memoryTokens}), ${truncatedCount} truncated`
		);

		return {
			blocks: finalBlocks,
			implicitContext,
			memoryContext,
			totalTokens,
			truncatedCount,
		};
	}

	/**
	 * Retrieve deep memory context from all three layers.
	 * Memory context is included BEFORE @-mentions in the system prompt
	 * as background knowledge (Team Knowledge → Project DNA → Decisions).
	 */
	private async _retrieveMemoryContext(userMessage: string): Promise<string> {
		try {
			const memoryResult: MemoryContext = await this.memoryRetriever.retrieve(userMessage);
			if (memoryResult.totalTokens === 0) {
				return '';
			}

			this.logService.trace(
				`[Nyrve] Memory context: ${memoryResult.totalTokens} tokens ` +
				`(team: ${memoryResult.layerBreakdown.team}, dna: ${memoryResult.layerBreakdown.dna}, ` +
				`decisions: ${memoryResult.layerBreakdown.decisions}) in ${memoryResult.retrievalTime}ms`
			);

			return memoryResult.contextString;
		} catch (error) {
			this.logService.error(`[Nyrve] Memory retrieval failed: ${error}`);
			return '';
		}
	}

	buildImplicitContext(): string {
		const state = this.editorBridge.getEditorState();
		const errorCount = state.diagnostics.filter(d => d.severity === 'error').length;
		const warningCount = state.diagnostics.filter(d => d.severity === 'warning').length;

		const parts = [
			`Project: ${state.projectRoot}`,
			`Active file: ${state.activeFilePath ?? 'none'}`,
		];

		if (state.activeFileLanguage) {
			parts.push(`Language: ${state.activeFileLanguage}`);
		}

		if (state.cursorPosition) {
			parts.push(`Cursor: line ${state.cursorPosition.line}, col ${state.cursorPosition.column}`);
		}

		if (state.gitBranch) {
			parts.push(`Git branch: ${state.gitBranch}`);
		}

		if (errorCount > 0 || warningCount > 0) {
			parts.push(`Diagnostics: ${errorCount} errors, ${warningCount} warnings`);
		}

		parts.push(`Open tabs: ${state.openTabs.length}`);

		return parts.join('\n');
	}

	estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	private _truncateToTokenBudget(content: string, maxTokens: number): string {
		const maxChars = maxTokens * 4;
		if (content.length <= maxChars) {
			return content;
		}

		// Truncate at a line boundary if possible
		const truncated = content.slice(0, maxChars);
		const lastNewline = truncated.lastIndexOf('\n');
		if (lastNewline > maxChars * 0.8) {
			return truncated.slice(0, lastNewline) + '\n... [truncated]';
		}

		return truncated + '\n... [truncated]';
	}
}

registerSingleton(INyrveContextBuilder, NyrveContextBuilder, InstantiationType.Delayed);
