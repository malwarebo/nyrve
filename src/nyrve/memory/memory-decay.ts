/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveMemoryEngine } from './memory-engine.js';

// --- Service Interface ---

export const INyrveMemoryDecay = createDecorator<INyrveMemoryDecay>('nyrveMemoryDecay');

export interface INyrveMemoryDecay {
	readonly _serviceBrand: undefined;

	/** Run decay pass: reduce confidence on stale memories. */
	runDecay(): void;

	/** Archive memories below the confidence threshold. */
	archiveStale(): number;

	/** Compact memories: merge similar entries. */
	compact(): number;
}

// --- Service Implementation ---

export class NyrveMemoryDecay extends Disposable implements INyrveMemoryDecay {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveMemoryEngine private readonly memoryEngine: INyrveMemoryEngine,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	runDecay(): void {
		const decayDays = this.configurationService.getValue<number>('nyrve.memory.decayDays') ?? 90;
		const now = Date.now();
		const decayThreshold = now - decayDays * 24 * 60 * 60 * 1000;

		let decayedCount = 0;
		for (const memory of this.memoryEngine.getAllMemories()) {
			// Don't decay user-verified memories
			if (memory.userVerified) {
				continue;
			}

			const lastAccessed = new Date(memory.lastAccessedAt).getTime();
			if (lastAccessed < decayThreshold) {
				const newConfidence = Math.max(0, memory.confidence - 0.1);
				this.memoryEngine.updateMemory(memory.id, { confidence: newConfidence });
				decayedCount++;
			}
		}

		if (decayedCount > 0) {
			this.logService.info(`[Nyrve] Decayed ${decayedCount} stale memories`);
		}
	}

	archiveStale(): number {
		const archiveThreshold = 0.2;
		let archivedCount = 0;

		for (const memory of this.memoryEngine.getAllMemories()) {
			if (memory.confidence < archiveThreshold && !memory.userVerified) {
				this.memoryEngine.deleteMemory(memory.id);
				archivedCount++;
			}
		}

		if (archivedCount > 0) {
			this.logService.info(`[Nyrve] Archived ${archivedCount} low-confidence memories`);
		}

		return archivedCount;
	}

	compact(): number {
		// Find and merge similar memories
		const memories = [...this.memoryEngine.getAllMemories()];
		const merged = new Set<string>();
		let mergedCount = 0;

		for (let i = 0; i < memories.length; i++) {
			if (merged.has(memories[i].id)) {
				continue;
			}

			for (let j = i + 1; j < memories.length; j++) {
				if (merged.has(memories[j].id)) {
					continue;
				}

				if (this._areSimilar(memories[i].content, memories[j].content)) {
					// Keep the one with higher confidence; merge tags
					const keep = memories[i].confidence >= memories[j].confidence ? memories[i] : memories[j];
					const remove = keep === memories[i] ? memories[j] : memories[i];

					const combinedTags = [...new Set([...keep.tags, ...remove.tags])];
					this.memoryEngine.updateMemory(keep.id, { tags: combinedTags });
					this.memoryEngine.deleteMemory(remove.id);
					merged.add(remove.id);
					mergedCount++;
				}
			}
		}

		if (mergedCount > 0) {
			this.logService.info(`[Nyrve] Compacted ${mergedCount} similar memories`);
		}

		return mergedCount;
	}

	private _areSimilar(a: string, b: string): boolean {
		// Simple Jaccard similarity on word sets
		const wordsA = new Set(a.toLowerCase().split(/\s+/));
		const wordsB = new Set(b.toLowerCase().split(/\s+/));

		let intersection = 0;
		for (const word of wordsA) {
			if (wordsB.has(word)) {
				intersection++;
			}
		}

		const union = wordsA.size + wordsB.size - intersection;
		return union > 0 && intersection / union > 0.7;
	}
}

registerSingleton(INyrveMemoryDecay, NyrveMemoryDecay, InstantiationType.Delayed);
