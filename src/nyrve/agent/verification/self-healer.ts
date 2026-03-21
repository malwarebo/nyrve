/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../vs/base/common/cancellation.js';
import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { INyrveAgentEngine, NyrveMessage } from '../agent-engine.js';
import { INyrveModelRouter } from '../model-router.js';
import { NyrveChangeSet, NyrveFileChange } from '../../ui/diff-review/diff-panel.js';

// --- Types ---

export interface VerificationFailure {
	readonly type: 'type_error' | 'test_failure' | 'import_error' | 'coverage_gap';
	readonly severity: 'error' | 'warning';
	readonly file: string;
	readonly line?: number;
	readonly message: string;
	readonly details: string;
}

export interface SelfHealFix {
	readonly failure: VerificationFailure;
	readonly fixDescription: string;
	readonly filesModified: string[];
	readonly diff: string;
}

export interface SelfHealResult {
	readonly status: 'healed' | 'partially_healed' | 'could_not_heal';
	readonly fixesApplied: SelfHealFix[];
	readonly remainingFailures: VerificationFailure[];
	readonly updatedChangeset: NyrveChangeSet;
}

export interface VerificationAttempt {
	readonly attemptNumber: number;
	readonly failures: VerificationFailure[];
	readonly fixesApplied: SelfHealFix[];
	readonly result: 'fixed' | 'partially_fixed' | 'could_not_fix';
}

interface SelfHealFixWithContent extends SelfHealFix {
	readonly newContent: string;
}

// --- Service Interface ---

export const INyrveSelfHealer = createDecorator<INyrveSelfHealer>('nyrveSelfHealer');

export interface INyrveSelfHealer {
	readonly _serviceBrand: undefined;

	/**
	 * Attempt to heal the changeset by asking the agent to fix verification failures.
	 */
	heal(
		changeset: NyrveChangeSet,
		failures: VerificationFailure[],
		attempt: number,
	): Promise<SelfHealResult>;
}

// --- Service Implementation ---

export class NyrveSelfHealer extends Disposable implements INyrveSelfHealer {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveAgentEngine private readonly agentEngine: INyrveAgentEngine,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async heal(
		changeset: NyrveChangeSet,
		failures: VerificationFailure[],
		attempt: number,
	): Promise<SelfHealResult> {
		const maxAttempts = this.configurationService.getValue<number>('nyrve.verification.maxSelfHealAttempts') ?? 3;
		const totalTimeout = this.configurationService.getValue<number>('nyrve.verification.selfHealTimeout') ?? 120000;

		if (attempt > maxAttempts) {
			return {
				status: 'could_not_heal',
				fixesApplied: [],
				remainingFailures: failures,
				updatedChangeset: changeset,
			};
		}

		this.logService.info(`[Nyrve] Self-healing attempt ${attempt}/${maxAttempts} for ${failures.length} failures`);

		const startTime = Date.now();

		try {
			// Build the heal prompt
			const healPrompt = this._buildHealPrompt(changeset, failures, attempt);

			// Send to the agent
			const cts = new CancellationTokenSource();

			// Set timeout
			const timeoutId = setTimeout(() => cts.cancel(), totalTimeout);

			const messages: NyrveMessage[] = [
				{
					role: 'user',
					content: healPrompt,
					timestamp: Date.now(),
				},
			];

			const response = await this.agentEngine.sendMessage(
				{
					messages,
					model: this.modelRouter.getChatModel(),
					systemPrompt: 'You are a code repair assistant. Fix the verification failures in the agent\'s code changes. Output ONLY the corrected file contents.',
					maxTokens: 16000,
				},
				cts.token,
			);

			clearTimeout(timeoutId);

			// Parse the agent's response for file changes
			const fixes = this._parseFixesFromResponse(response.content, changeset, failures);

			// Validate fixes — agent cannot delete/skip tests
			const validFixes = this._validateFixes(fixes);

			// Apply fixes to the changeset
			const updatedChangeset = this._applyFixes(changeset, validFixes);

			const elapsed = Date.now() - startTime;
			this.logService.info(`[Nyrve] Self-heal attempt ${attempt} applied ${validFixes.length} fixes in ${elapsed}ms`);

			if (validFixes.length === failures.length) {
				return {
					status: 'healed',
					fixesApplied: validFixes,
					remainingFailures: [],
					updatedChangeset,
				};
			} else if (validFixes.length > 0) {
				const fixedFiles = new Set(validFixes.flatMap(f => f.filesModified));
				const remaining = failures.filter(f => !fixedFiles.has(f.file));
				return {
					status: 'partially_healed',
					fixesApplied: validFixes,
					remainingFailures: remaining,
					updatedChangeset,
				};
			} else {
				return {
					status: 'could_not_heal',
					fixesApplied: [],
					remainingFailures: failures,
					updatedChangeset: changeset,
				};
			}
		} catch (error) {
			this.logService.error(`[Nyrve] Self-heal attempt ${attempt} failed: ${error}`);
			return {
				status: 'could_not_heal',
				fixesApplied: [],
				remainingFailures: failures,
				updatedChangeset: changeset,
			};
		}
	}

	private _buildHealPrompt(
		changeset: NyrveChangeSet,
		failures: VerificationFailure[],
		attempt: number,
	): string {
		const parts: string[] = [];

		parts.push(`Your previous code changes have verification failures. Fix them. (Attempt ${attempt})`);
		parts.push('');
		parts.push('## Failures');
		parts.push('');

		for (const failure of failures) {
			parts.push(`### ${failure.type}: ${failure.message}`);
			parts.push(`File: ${failure.file}${failure.line ? `:${failure.line}` : ''}`);
			parts.push(`Details: ${failure.details}`);
			parts.push('');
		}

		parts.push('## Rules');
		parts.push('- Fix ONLY the failures listed above');
		parts.push('- Do not change code unrelated to the failures');
		parts.push('- Do not remove or skip tests to make them pass');
		parts.push('- Do not use .skip, .todo, or .only on tests');
		parts.push('- If a test failure reveals a genuine bug in your logic, fix the logic');
		parts.push('');
		parts.push('## Your previous changes');
		parts.push('');

		for (const file of changeset.files) {
			parts.push(`### ${file.filePath}`);
			parts.push('```');
			parts.push(file.proposedContent);
			parts.push('```');
			parts.push('');
		}

		parts.push('Output EACH file that needs changes as:');
		parts.push('### FILE: <path>');
		parts.push('```');
		parts.push('<full corrected file content>');
		parts.push('```');

		return parts.join('\n');
	}

	/**
	 * Parse file changes from the agent's heal response.
	 */
	private _parseFixesFromResponse(
		response: string,
		changeset: NyrveChangeSet,
		failures: VerificationFailure[],
	): SelfHealFixWithContent[] {
		const fixes: SelfHealFixWithContent[] = [];

		// Parse "### FILE: <path>" blocks
		const filePattern = /### FILE:\s*(.+?)\n```(?:\w*)\n([\s\S]*?)```/g;
		let match: RegExpExecArray | null;

		while ((match = filePattern.exec(response)) !== null) {
			const filePath = match[1].trim();
			const newContent = match[2];

			// Find which failures this fix addresses
			const relatedFailures = failures.filter(f => f.file === filePath);
			if (relatedFailures.length === 0) {
				continue;
			}

			// Check if the file was in the original changeset
			const originalFile = changeset.files.find(f => f.filePath === filePath);
			const previousContent = originalFile?.proposedContent ?? '';

			fixes.push({
				failure: relatedFailures[0],
				fixDescription: `Fixed ${relatedFailures.length} issue(s) in ${filePath}`,
				filesModified: [filePath],
				diff: this._computeSimpleDiff(previousContent, newContent),
				newContent,
			});
		}

		return fixes;
	}

	/**
	 * Validate that fixes don't delete or skip tests.
	 * The agent CANNOT delete tests, skip tests, or use .todo/.skip to pass.
	 */
	private _validateFixes(fixes: SelfHealFixWithContent[]): SelfHealFixWithContent[] {
		return fixes.filter(fix => {
			const diff = fix.diff;

			// Check for test-skipping patterns
			const forbiddenPatterns = [
				/\.skip\s*\(/,    // .skip(
				/\.todo\s*\(/,    // .todo(
				/\.only\s*\(/,    // .only( (selective running)
				/xit\s*\(/,       // xit( (Jasmine skip)
				/xdescribe\s*\(/, // xdescribe(
				/@pytest\.mark\.skip/,    // pytest skip
				/@unittest\.skip/,        // unittest skip
				/#\[ignore\]/,            // Rust ignore
				/t\.Skip\(\)/,            // Go skip
			];

			for (const pattern of forbiddenPatterns) {
				if (pattern.test(diff)) {
					this.logService.warn(`[Nyrve] Self-heal fix rejected: attempted to skip/disable tests in ${fix.filesModified[0]}`);
					return false;
				}
			}

			return true;
		});
	}

	/**
	 * Apply fixes to the changeset, producing an updated changeset.
	 */
	private _applyFixes(changeset: NyrveChangeSet, fixes: SelfHealFixWithContent[]): NyrveChangeSet {
		const fileContentMap = new Map<string, string>();
		for (const fix of fixes) {
			for (const file of fix.filesModified) {
				fileContentMap.set(file, fix.newContent);
			}
		}

		const updatedFiles: NyrveFileChange[] = changeset.files.map(file => {
			const newContent = fileContentMap.get(file.filePath);
			if (newContent !== undefined) {
				return {
					...file,
					proposedContent: newContent,
					hunks: file.hunks,
				};
			}
			return file;
		});

		return {
			...changeset,
			files: updatedFiles,
		};
	}

	private _computeSimpleDiff(before: string, after: string): string {
		const beforeLines = before.split('\n');
		const afterLines = after.split('\n');
		const diffParts: string[] = [];

		const maxLen = Math.max(beforeLines.length, afterLines.length);
		for (let i = 0; i < maxLen; i++) {
			if (i >= beforeLines.length) {
				diffParts.push(`+${afterLines[i]}`);
			} else if (i >= afterLines.length) {
				diffParts.push(`-${beforeLines[i]}`);
			} else if (beforeLines[i] !== afterLines[i]) {
				diffParts.push(`-${beforeLines[i]}`);
				diffParts.push(`+${afterLines[i]}`);
			}
		}

		return diffParts.join('\n');
	}
}

registerSingleton(INyrveSelfHealer, NyrveSelfHealer, InstantiationType.Delayed);
