/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { MemorySource, MemoryType, INyrveMemoryEngine } from './memory-engine.js';

// --- Types ---

export interface ConversationMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
}

// --- Service Interface ---

export const INyrveMemoryExtractor = createDecorator<INyrveMemoryExtractor>('nyrveMemoryExtractor');

export interface INyrveMemoryExtractor {
	readonly _serviceBrand: undefined;

	/**
	 * Extract memories from a conversation.
	 * Parses user explicit "remember" commands and infers project knowledge.
	 */
	extractFromConversation(messages: readonly ConversationMessage[]): void;

	/**
	 * Process a user explicit memory command (e.g., "Remember that we use pnpm").
	 */
	processExplicitMemory(content: string): void;
}

// --- Service Implementation ---

/** Patterns that indicate user wants to store a memory. */
const EXPLICIT_MEMORY_PATTERNS = [
	/^remember\s+that\s+(.+)/i,
	/^note\s+that\s+(.+)/i,
	/^keep\s+in\s+mind\s+that\s+(.+)/i,
	/^don'?t\s+nyrvet\s+that\s+(.+)/i,
];

/** Heuristic keyword mapping for auto-classifying memory types. */
const TYPE_KEYWORDS: ReadonlyArray<{ keywords: readonly string[]; type: MemoryType }> = [
	{ keywords: ['prefer', 'style', 'always use', 'never use', 'like to'], type: MemoryType.CodingStyle },
	{ keywords: ['convention', 'naming', 'format', 'pattern'], type: MemoryType.Convention },
	{ keywords: ['architecture', 'design', 'chose', 'decided', 'because'], type: MemoryType.ArchitectureDecision },
	{ keywords: ['stack', 'framework', 'built with', 'using'], type: MemoryType.TechStack },
	{ keywords: ['structure', 'folder', 'directory', 'layout'], type: MemoryType.ProjectStructure },
	{ keywords: ['tool', 'npm', 'pnpm', 'yarn', 'pip', 'cargo'], type: MemoryType.ToolPreference },
	{ keywords: ['todo', 'need to', 'should', 'still need'], type: MemoryType.UnresolvedTodo },
	{ keywords: ['bug', 'issue', 'broken', 'flaky', 'fails'], type: MemoryType.BugContext },
	{ keywords: ['error', 'fix', 'resolve', 'workaround', 'when you see'], type: MemoryType.ErrorResolution },
];

export class NyrveMemoryExtractor extends Disposable implements INyrveMemoryExtractor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveMemoryEngine private readonly memoryEngine: INyrveMemoryEngine,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	extractFromConversation(messages: readonly ConversationMessage[]): void {
		const autoExtract = this.configurationService.getValue<boolean>('nyrve.memory.autoExtract') ?? true;
		if (!autoExtract) {
			return;
		}

		for (const msg of messages) {
			if (msg.role === 'user') {
				// Check for explicit memory commands
				for (const pattern of EXPLICIT_MEMORY_PATTERNS) {
					const match = pattern.exec(msg.content);
					if (match) {
						this.processExplicitMemory(match[1]);
						break;
					}
				}
			}
		}
	}

	processExplicitMemory(content: string): void {
		const type = this._classifyMemoryType(content);

		this.memoryEngine.addMemory({
			type,
			content,
			embedding: [], // Would be populated by embedding model in full implementation
			source: MemorySource.UserExplicit,
			tags: this._extractTags(content),
			confidence: 1.0,
			userVerified: true,
		});

		this.logService.info(`[Nyrve] Stored explicit memory: ${content.slice(0, 60)}...`);
	}

	private _classifyMemoryType(content: string): MemoryType {
		const lower = content.toLowerCase();

		for (const entry of TYPE_KEYWORDS) {
			if (entry.keywords.some(kw => lower.includes(kw))) {
				return entry.type;
			}
		}

		return MemoryType.Convention; // Default fallback
	}

	private _extractTags(content: string): string[] {
		const tags: string[] = [];
		const lower = content.toLowerCase();

		// Extract common technology mentions as tags
		const techPatterns = ['typescript', 'javascript', 'react', 'vue', 'angular', 'next.js', 'node',
			'python', 'rust', 'go', 'java', 'docker', 'kubernetes', 'postgres', 'mongodb', 'redis',
			'prisma', 'graphql', 'rest', 'api', 'css', 'tailwind', 'eslint', 'prettier'];

		for (const tech of techPatterns) {
			if (lower.includes(tech)) {
				tags.push(tech);
			}
		}

		return tags;
	}
}

registerSingleton(INyrveMemoryExtractor, NyrveMemoryExtractor, InstantiationType.Delayed);
