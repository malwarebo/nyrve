/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { INyrveProjectDNA } from './project-dna.js';
import { INyrveDecisionJournal } from './decision-journal.js';
import { INyrveTeamKnowledge } from './team-knowledge.js';

// --- Types ---

export interface RetrievalOptions {
	readonly maxTokens?: number;
	readonly layers?: ('dna' | 'decisions' | 'team')[];
	readonly modules?: string[];
}

export interface MemoryContext {
	readonly contextString: string;
	readonly teamKnowledge: string;
	readonly projectDNA: string;
	readonly relevantDecisions: string;
	readonly totalTokens: number;
	readonly layerBreakdown: {
		team: number;
		dna: number;
		decisions: number;
	};
	readonly retrievalTime: number;
}

// --- Service Interface ---

export const INyrveMemoryRetriever = createDecorator<INyrveMemoryRetriever>('nyrveMemoryRetriever');

export interface INyrveMemoryRetriever {
	readonly _serviceBrand: undefined;

	/** Retrieve assembled memory context for an agent request. */
	retrieve(query: string, options?: RetrievalOptions): Promise<MemoryContext>;
}

// --- Service Implementation ---

export class NyrveMemoryRetriever extends Disposable implements INyrveMemoryRetriever {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveProjectDNA private readonly projectDNA: INyrveProjectDNA,
		@INyrveDecisionJournal private readonly decisionJournal: INyrveDecisionJournal,
		@INyrveTeamKnowledge private readonly teamKnowledge: INyrveTeamKnowledge,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async retrieve(query: string, options?: RetrievalOptions): Promise<MemoryContext> {
		const startTime = Date.now();
		const maxTokens = options?.maxTokens
			?? this.configurationService.getValue<number>('nyrve.memory.retrieval.maxTokens')
			?? 3000;
		const layers = options?.layers ?? ['team', 'dna', 'decisions'];

		const deepMemoryEnabled = this.configurationService.getValue<boolean>('nyrve.memory.deepMemoryEnabled') ?? true;
		if (!deepMemoryEnabled) {
			return this._emptyContext(Date.now() - startTime);
		}

		let remainingBudget = maxTokens;
		let teamKnowledgeText = '';
		let dnaText = '';
		let decisionsText = '';

		// Priority 1: Team Knowledge (highest priority, human-curated)
		if (layers.includes('team')) {
			teamKnowledgeText = await this._getTeamKnowledge();
			const teamTokens = this._estimateTokens(teamKnowledgeText);
			if (teamTokens <= remainingBudget) {
				remainingBudget -= teamTokens;
			} else {
				teamKnowledgeText = this._truncate(teamKnowledgeText, remainingBudget);
				remainingBudget = 0;
			}
		}

		// Priority 2: Project DNA (compressed summary)
		if (layers.includes('dna') && remainingBudget > 0) {
			dnaText = this._getDNASummary();
			const dnaTokens = this._estimateTokens(dnaText);
			if (dnaTokens <= remainingBudget) {
				remainingBudget -= dnaTokens;
			} else {
				dnaText = this._truncate(dnaText, remainingBudget);
				remainingBudget = 0;
			}
		}

		// Priority 3: Relevant decisions (semantic search by query)
		if (layers.includes('decisions') && remainingBudget > 0) {
			decisionsText = await this._getRelevantDecisions(query, options?.modules, remainingBudget);
			const decisionTokens = this._estimateTokens(decisionsText);
			remainingBudget -= Math.min(decisionTokens, remainingBudget);
		}

		// Assemble the full context string
		const parts: string[] = [];
		if (teamKnowledgeText) {
			parts.push(teamKnowledgeText);
		}
		if (dnaText) {
			parts.push(dnaText);
		}
		if (decisionsText) {
			parts.push(decisionsText);
		}

		const contextString = parts.join('\n\n');
		const totalTokens = this._estimateTokens(contextString);
		const retrievalTime = Date.now() - startTime;

		this.logService.trace(
			`[Nyrve] Memory retrieved: ${totalTokens} tokens in ${retrievalTime}ms ` +
			`(team: ${this._estimateTokens(teamKnowledgeText)}, dna: ${this._estimateTokens(dnaText)}, ` +
			`decisions: ${this._estimateTokens(decisionsText)})`
		);

		return {
			contextString,
			teamKnowledge: teamKnowledgeText,
			projectDNA: dnaText,
			relevantDecisions: decisionsText,
			totalTokens,
			layerBreakdown: {
				team: this._estimateTokens(teamKnowledgeText),
				dna: this._estimateTokens(dnaText),
				decisions: this._estimateTokens(decisionsText),
			},
			retrievalTime,
		};
	}

	private async _getTeamKnowledge(): Promise<string> {
		try {
			return await this.teamKnowledge.getContextBlock();
		} catch {
			return '';
		}
	}

	private _getDNASummary(): string {
		const summary = this.projectDNA.getCompressedSummary();
		return summary ? `## Project DNA\n${summary}` : '';
	}

	private async _getRelevantDecisions(
		query: string,
		modules?: string[],
		tokenBudget?: number,
	): Promise<string> {
		try {
			// Search by query
			const queryResults = await this.decisionJournal.searchDecisions(query, 5);

			// Also search by module if specified
			const moduleResults: typeof queryResults = [];
			if (modules) {
				for (const mod of modules) {
					const results = await this.decisionJournal.getDecisionsByModule(mod);
					moduleResults.push(...results);
				}
			}

			// Merge and deduplicate
			const seen = new Set<string>();
			const allResults = [];
			for (const r of [...queryResults, ...moduleResults]) {
				if (!seen.has(r.id)) {
					seen.add(r.id);
					allResults.push(r);
				}
			}

			if (allResults.length === 0) {
				return '';
			}

			// Format as context block
			const parts: string[] = ['## Relevant Decisions'];
			let currentTokens = this._estimateTokens(parts[0]);
			const budget = tokenBudget ?? 1000;

			for (const decision of allResults) {
				const line = `- [${decision.date.split('T')[0]}] "${decision.title}" — ${decision.rationale}` +
					(decision.filesAffected.length > 0 ? `\n  Affects: ${decision.filesAffected.join(', ')}` : '');

				const lineTokens = this._estimateTokens(line);
				if (currentTokens + lineTokens > budget) {
					break;
				}

				parts.push(line);
				currentTokens += lineTokens;
			}

			return parts.length > 1 ? parts.join('\n') : '';
		} catch {
			return '';
		}
	}

	private _estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	private _truncate(text: string, maxTokens: number): string {
		const maxChars = maxTokens * 4;
		if (text.length <= maxChars) {
			return text;
		}
		const truncated = text.slice(0, maxChars);
		const lastNewline = truncated.lastIndexOf('\n');
		if (lastNewline > maxChars * 0.8) {
			return truncated.slice(0, lastNewline) + '\n... [truncated]';
		}
		return truncated + '\n... [truncated]';
	}

	private _emptyContext(retrievalTime: number): MemoryContext {
		return {
			contextString: '',
			teamKnowledge: '',
			projectDNA: '',
			relevantDecisions: '',
			totalTokens: 0,
			layerBreakdown: { team: 0, dna: 0, decisions: 0 },
			retrievalTime,
		};
	}
}

registerSingleton(INyrveMemoryRetriever, NyrveMemoryRetriever, InstantiationType.Delayed);
