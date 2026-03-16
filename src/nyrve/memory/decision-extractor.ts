/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../vs/base/common/cancellation.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { NyrveMessage, INyrveAgentEngine } from '../agent/agent-engine.js';
import { INyrveModelRouter } from '../agent/model-router.js';
import { INyrveDecisionJournal, DecisionEntry } from './decision-journal.js';

// --- Service Interface ---

export const INyrveDecisionExtractor = createDecorator<INyrveDecisionExtractor>('nyrveDecisionExtractor');

export interface INyrveDecisionExtractor {
	readonly _serviceBrand: undefined;

	/** Extract decisions from a conversation. */
	extractFromConversation(messages: NyrveMessage[], conversationId?: string): Promise<DecisionEntry[]>;

	/** Extract decisions from a git commit. */
	extractFromCommit(commitHash: string, message: string, diff: string): Promise<DecisionEntry[]>;

	/** Check if a commit is likely to contain a decision worth extracting. */
	shouldExtractFromCommit(message: string, diff: string, fileCount: number): boolean;
}

// --- Service Implementation ---

export class NyrveDecisionExtractor extends Disposable implements INyrveDecisionExtractor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveAgentEngine private readonly agentEngine: INyrveAgentEngine,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveDecisionJournal private readonly journal: INyrveDecisionJournal,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async extractFromConversation(messages: NyrveMessage[], conversationId?: string): Promise<DecisionEntry[]> {
		const enabled = this.configurationService.getValue<boolean>('nyrve.memory.decisions.autoExtract') ?? true;
		if (!enabled) {
			return [];
		}

		if (messages.length < 4) {
			// Too short — unlikely to contain a decision
			return [];
		}

		this.logService.info('[Nyrve] Extracting decisions from conversation...');

		const conversationText = messages
			.map(m => `${m.role === 'user' ? 'Developer' : 'AI'}: ${m.content.slice(0, 2000)}`)
			.join('\n\n');

		const prompt = this._buildExtractionPrompt(conversationText);

		try {
			const cts = new CancellationTokenSource();
			const response = await this.agentEngine.sendMessage(
				{
					messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
					model: this.modelRouter.getBackgroundModel(), // Haiku for cost efficiency
					systemPrompt: 'You are a decision extraction assistant. Extract architectural decisions from conversations. Always respond with valid JSON.',
					maxTokens: 2000,
				},
				cts.token,
			);

			const decisions = this._parseExtractionResponse(response.content, 'conversation', conversationId);

			// Save each decision
			for (const decision of decisions) {
				await this.journal.addDecision(decision);
			}

			if (decisions.length > 0) {
				this.logService.info(`[Nyrve] Extracted ${decisions.length} decision(s) from conversation`);
			}

			return decisions;
		} catch (error) {
			this.logService.error(`[Nyrve] Decision extraction failed: ${error}`);
			return [];
		}
	}

	async extractFromCommit(commitHash: string, message: string, diff: string): Promise<DecisionEntry[]> {
		const enabled = this.configurationService.getValue<boolean>('nyrve.memory.decisions.extractFromCommits') ?? true;
		if (!enabled) {
			return [];
		}

		if (!this.shouldExtractFromCommit(message, diff, 0)) {
			return [];
		}

		this.logService.info(`[Nyrve] Extracting decisions from commit ${commitHash.slice(0, 7)}...`);

		// Truncate diff for the prompt
		const truncatedDiff = diff.length > 5000 ? diff.slice(0, 5000) + '\n... [truncated]' : diff;

		const prompt = `Analyze this git commit and extract any architectural decisions.\n\n` +
			`## Commit Message\n${message}\n\n` +
			`## Diff Summary\n${truncatedDiff}\n\n` +
			`Respond with a JSON array of decisions. Each decision:\n` +
			`{ "title": "...", "description": "...", "rationale": "...", "alternativesConsidered": [{"name": "...", "reason": "..."}], "tags": ["..."], "filesAffected": ["..."] }\n\n` +
			`If no decisions were made, output: []`;

		try {
			const cts = new CancellationTokenSource();
			const response = await this.agentEngine.sendMessage(
				{
					messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
					model: this.modelRouter.getBackgroundModel(),
					systemPrompt: 'Extract architectural decisions from this commit. Respond with valid JSON only.',
					maxTokens: 2000,
				},
				cts.token,
			);

			const decisions = this._parseExtractionResponse(response.content, 'commit', undefined, commitHash);

			for (const decision of decisions) {
				await this.journal.addDecision(decision);
			}

			return decisions;
		} catch (error) {
			this.logService.error(`[Nyrve] Commit decision extraction failed: ${error}`);
			return [];
		}
	}

	shouldExtractFromCommit(message: string, _diff: string, fileCount: number): boolean {
		// Heuristics from spec Section 3.4.2
		if (message.length > 50) {
			return true;
		}
		if (fileCount > 3) {
			return true;
		}

		const decisionKeywords = [
			'switch to', 'migrate', 'replace', 'introduce', 'remove', 'deprecate',
			'refactor', 'redesign', 'adopt', 'drop', 'upgrade', 'downgrade',
		];

		const msgLower = message.toLowerCase();
		return decisionKeywords.some(kw => msgLower.includes(kw));
	}

	// --- Private ---

	private _buildExtractionPrompt(conversation: string): string {
		return `Analyze this conversation between a developer and an AI coding assistant.
Extract any architectural decisions, technology choices, convention changes,
or significant rationale that was discussed.

For each decision found, output JSON with:
- title: Short summary (max 10 words)
- description: What was decided
- rationale: Why it was decided
- alternativesConsidered: Other options discussed and why they were rejected
- tags: Relevant topic tags
- filesAffected: Files that were created or modified as part of this decision

If no decisions were made (e.g., the conversation was just a quick question or
a small bug fix), output an empty array.

Respond with ONLY a JSON array.

Conversation:
${conversation.slice(0, 10000)}`;
	}

	private _parseExtractionResponse(
		response: string,
		source: DecisionEntry['source'],
		conversationId?: string,
		commitHash?: string,
	): DecisionEntry[] {
		try {
			// Extract JSON array from the response
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				return [];
			}

			const data = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(data)) {
				return [];
			}

			return data.map((d: Record<string, unknown>): DecisionEntry => ({
				id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				title: String(d.title ?? ''),
				description: String(d.description ?? ''),
				rationale: String(d.rationale ?? ''),
				alternativesConsidered: Array.isArray(d.alternativesConsidered)
					? d.alternativesConsidered.map((a: Record<string, unknown>) => ({
						name: String(a.name ?? ''),
						reason: String(a.reason ?? ''),
					}))
					: [],
				date: new Date().toISOString(),
				tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
				filesAffected: Array.isArray(d.filesAffected) ? d.filesAffected.map(String) : [],
				modulesAffected: [],
				source,
				conversationId,
				commitHash,
				status: 'active',
				embedding: [],
			}));
		} catch (error) {
			this.logService.error(`[Nyrve] Failed to parse extraction response: ${error}`);
			return [];
		}
	}
}

registerSingleton(INyrveDecisionExtractor, NyrveDecisionExtractor, InstantiationType.Delayed);
