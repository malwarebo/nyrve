/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../vs/base/common/cancellation.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { INyrveAgentEngine } from '../../agent/agent-engine.js';
import { INyrveModelRouter } from '../../agent/model-router.js';
import { INyrveIndexManager } from '../../indexer/index-manager.js';

// --- Types ---

export interface CodePattern {
	readonly name: string;
	readonly description: string;
	readonly evidence: Array<{
		file: string;
		line: number;
		snippet: string;
	}>;
	readonly frequency: number;
	readonly confidence: number;
}

export interface Convention {
	readonly name: string;
	readonly category: string;
	readonly rule: string;
	readonly detectedFrom: string;
	readonly examples: string[];
}

export interface PatternDetectionResult {
	readonly patterns: CodePattern[];
	readonly conventions: Convention[];
}

// --- Detector ---

export class NyrvePatternDetector {
	constructor(
		private readonly agentEngine: INyrveAgentEngine,
		private readonly modelRouter: INyrveModelRouter,
		private readonly indexManager: INyrveIndexManager,
		private readonly logService: ILogService,
	) {}

	async detect(): Promise<PatternDetectionResult> {
		this.logService.info('[Nyrve] Pattern detector: sampling files for pattern analysis...');

		// Sample 20-30 representative files from different modules
		const samples = this._sampleRepresentativeFiles(25);
		if (samples.length === 0) {
			return { patterns: [], conventions: [] };
		}

		// Build the prompt with code samples
		const prompt = this._buildAnalysisPrompt(samples);

		try {
			const cts = new CancellationTokenSource();

			const response = await this.agentEngine.sendMessage(
				{
					messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
					model: this.modelRouter.getBackgroundModel(), // Use Haiku for cost efficiency
					systemPrompt: 'You are a code analysis assistant. Analyze code samples and identify recurring patterns and conventions. Always respond with valid JSON.',
					maxTokens: 4000,
				},
				cts.token,
			);

			return this._parseResponse(response.content);
		} catch (error) {
			this.logService.error(`[Nyrve] Pattern detection failed: ${error}`);
			return { patterns: [], conventions: [] };
		}
	}

	private _sampleRepresentativeFiles(count: number): Array<{ path: string; content: string }> {
		const allFiles = this.indexManager.searchFiles('');
		if (allFiles.length === 0) {
			return [];
		}

		// Group files by directory to ensure diversity
		const byDir = new Map<string, string[]>();
		for (const filePath of allFiles) {
			const dir = filePath.replace(/\/[^/]+$/, '');
			if (!byDir.has(dir)) {
				byDir.set(dir, []);
			}
			byDir.get(dir)!.push(filePath);
		}

		// Take one file from each directory, preferring larger files
		const selected: Array<{ path: string; content: string }> = [];
		const dirs = [...byDir.entries()].sort(([, a], [, b]) => b.length - a.length);

		for (const [, files] of dirs) {
			if (selected.length >= count) {
				break;
			}

			// Pick the file with most symbols (likely most representative)
			const sortedFiles = [...files].sort((a, b) => {
				const symA = this.indexManager.getFileSymbols(a).length;
				const symB = this.indexManager.getFileSymbols(b).length;
				return symB - symA;
			});
			const bestFilePath = sortedFiles[0];

			if (bestFilePath) {
				const entry = this.indexManager.getFileEntry(bestFilePath);
				if (entry && entry.lineCount <= 300) {
					const symbols = this.indexManager.getFileSymbols(bestFilePath);
					const summary = symbols.map(s =>
						`${s.kind} ${s.containerName ? s.containerName + '.' : ''}${s.name} (line ${s.lineStart}-${s.lineEnd})${s.signature ? ': ' + s.signature : ''}`
					).join('\n');

					selected.push({
						path: bestFilePath,
						content: `File: ${bestFilePath} (${entry.lineCount} lines, ${entry.language})\nSymbols:\n${summary}`,
					});
				}
			}
		}

		return selected;
	}

	private _buildAnalysisPrompt(samples: Array<{ path: string; content: string }>): string {
		const parts: string[] = [];

		parts.push('Analyze these code file summaries from a software project. Identify:');
		parts.push('1. Recurring architectural PATTERNS (e.g., "Repository pattern", "Service layer", "Factory pattern")');
		parts.push('2. Coding CONVENTIONS (e.g., naming conventions, file organization, import styles)');
		parts.push('');
		parts.push('For each pattern, note which files follow it and your confidence (0-1).');
		parts.push('For each convention, note the rule and category.');
		parts.push('');
		parts.push('Respond with ONLY a JSON object in this format:');
		parts.push('```json');
		parts.push('{');
		parts.push('  "patterns": [');
		parts.push('    { "name": "...", "description": "...", "files": ["..."], "frequency": N, "confidence": 0.X }');
		parts.push('  ],');
		parts.push('  "conventions": [');
		parts.push('    { "name": "...", "category": "naming|structure|imports|error-handling|testing|other", "rule": "...", "detectedFrom": "...", "examples": ["..."] }');
		parts.push('  ]');
		parts.push('}');
		parts.push('```');
		parts.push('');
		parts.push('## Code Samples');
		parts.push('');

		for (const sample of samples) {
			parts.push(`### ${sample.path}`);
			parts.push('```');
			parts.push(sample.content);
			parts.push('```');
			parts.push('');
		}

		return parts.join('\n');
	}

	private _parseResponse(response: string): PatternDetectionResult {
		try {
			// Extract JSON from the response (may be wrapped in markdown code blocks)
			const jsonMatch = response.match(/\{[\s\S]*"patterns"[\s\S]*"conventions"[\s\S]*\}/);
			if (!jsonMatch) {
				return { patterns: [], conventions: [] };
			}

			const data = JSON.parse(jsonMatch[0]);

			const patterns: CodePattern[] = (data.patterns ?? []).map((p: Record<string, unknown>) => ({
				name: String(p.name ?? ''),
				description: String(p.description ?? ''),
				evidence: (Array.isArray(p.files) ? p.files : []).map((f: string) => ({
					file: f,
					line: 0,
					snippet: '',
				})),
				frequency: Number(p.frequency ?? 0),
				confidence: Number(p.confidence ?? 0),
			}));

			const conventions: Convention[] = (data.conventions ?? []).map((c: Record<string, unknown>) => ({
				name: String(c.name ?? ''),
				category: String(c.category ?? 'other'),
				rule: String(c.rule ?? ''),
				detectedFrom: String(c.detectedFrom ?? 'code analysis'),
				examples: Array.isArray(c.examples) ? c.examples.map(String) : [],
			}));

			this.logService.info(`[Nyrve] Pattern detection: found ${patterns.length} patterns, ${conventions.length} conventions`);

			return { patterns, conventions };
		} catch (error) {
			this.logService.error(`[Nyrve] Failed to parse pattern detection response: ${error}`);
			return { patterns: [], conventions: [] };
		}
	}
}
