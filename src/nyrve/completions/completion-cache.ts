/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';

// --- Types ---

export interface CachedCompletion {
	readonly text: string;
	readonly timestamp: number;
	readonly model: string;
	readonly tokens: number;
}

export interface CacheLookupResult {
	readonly hit: boolean;
	readonly completion?: CachedCompletion;
	/** Remaining text after prefix match (user typed part of a cached completion). */
	readonly remainingText?: string;
}

// --- Service Interface ---

export const INyrveCompletionCache = createDecorator<INyrveCompletionCache>('nyrveCompletionCache');

export interface INyrveCompletionCache {
	readonly _serviceBrand: undefined;

	/** Look up a completion in the cache. */
	lookup(prefix: string, suffix: string, lineText: string): CacheLookupResult;

	/**
	 * Try prefix match: if the user typed characters matching the start of a
	 * cached completion, return the remaining text.
	 */
	lookupPrefixMatch(prefix: string, suffix: string, lineText: string): CacheLookupResult;

	/** Store a completion in the cache. */
	store(prefix: string, suffix: string, lineText: string, completion: CachedCompletion): void;

	/** Invalidate the entire cache. */
	clear(): void;

	/** Get cache stats. */
	getStats(): { size: number; hits: number; misses: number; hitRate: number };
}

// --- Implementation ---

interface CacheEntry {
	readonly key: string;
	readonly completion: CachedCompletion;
	readonly prefixKey: string;
	lastAccessed: number;
}

export class NyrveCompletionCache extends Disposable implements INyrveCompletionCache {
	declare readonly _serviceBrand: undefined;

	private readonly _entries = new Map<string, CacheEntry>();
	/** Index from prefix key → full cache key, for prefix match lookups. */
	private readonly _prefixIndex = new Map<string, string[]>();

	private _hits = 0;
	private _misses = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	lookup(prefix: string, suffix: string, lineText: string): CacheLookupResult {
		const key = this._computeKey(prefix, suffix, lineText);
		const entry = this._entries.get(key);

		if (!entry) {
			this._misses++;
			return { hit: false };
		}

		// Check TTL
		const ttl = (this.configurationService.getValue<number>('nyrve.completions.cacheTTL') ?? 30) * 1000;
		if (Date.now() - entry.completion.timestamp > ttl) {
			this._entries.delete(key);
			this._misses++;
			return { hit: false };
		}

		entry.lastAccessed = Date.now();
		this._hits++;
		return { hit: true, completion: entry.completion };
	}

	lookupPrefixMatch(prefix: string, suffix: string, lineText: string): CacheLookupResult {
		// Check if the current prefix extends a previously cached prefix.
		// e.g., cached key was for prefix "const x = " and now prefix is "const x = f"
		// If the cached completion started with "foo()", we can return "oo()".
		const ttl = (this.configurationService.getValue<number>('nyrve.completions.cacheTTL') ?? 30) * 1000;
		const now = Date.now();

		for (const [, entry] of this._entries) {
			if (now - entry.completion.timestamp > ttl) {
				continue;
			}

			// Does current prefix start with the cached prefix?
			// The cached key encodes the prefix — reconstruct it
			const cachedPrefix = entry.prefixKey;
			if (prefix.startsWith(cachedPrefix) && prefix.length > cachedPrefix.length) {
				const typedExtra = prefix.slice(cachedPrefix.length);
				const cachedText = entry.completion.text;

				// Does the cached completion start with what the user typed since caching?
				if (cachedText.startsWith(typedExtra)) {
					const remaining = cachedText.slice(typedExtra.length);
					if (remaining.length > 0) {
						entry.lastAccessed = now;
						this._hits++;
						return {
							hit: true,
							completion: { ...entry.completion, text: remaining },
							remainingText: remaining,
						};
					}
				}
			}
		}

		this._misses++;
		return { hit: false };
	}

	store(prefix: string, suffix: string, lineText: string, completion: CachedCompletion): void {
		const maxSize = this.configurationService.getValue<number>('nyrve.completions.cacheSize') ?? 100;

		// Evict if at capacity (LRU)
		if (this._entries.size >= maxSize) {
			this._evictLRU();
		}

		const key = this._computeKey(prefix, suffix, lineText);
		const prefixKey = prefix.slice(-200);

		const entry: CacheEntry = {
			key,
			completion,
			prefixKey,
			lastAccessed: Date.now(),
		};

		this._entries.set(key, entry);

		// Update prefix index
		if (!this._prefixIndex.has(prefixKey)) {
			this._prefixIndex.set(prefixKey, []);
		}
		this._prefixIndex.get(prefixKey)!.push(key);
	}

	clear(): void {
		this._entries.clear();
		this._prefixIndex.clear();
	}

	getStats(): { size: number; hits: number; misses: number; hitRate: number } {
		const total = this._hits + this._misses;
		return {
			size: this._entries.size,
			hits: this._hits,
			misses: this._misses,
			hitRate: total > 0 ? this._hits / total : 0,
		};
	}

	private _computeKey(prefix: string, suffix: string, lineText: string): string {
		// Hash of (prefix 200 chars + suffix 100 chars + current line text)
		const raw = prefix.slice(-200) + '||' + suffix.slice(0, 100) + '||' + lineText;
		return this._simpleHash(raw);
	}

	private _simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const chr = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + chr;
			hash |= 0; // Convert to 32bit integer
		}
		return hash.toString(36);
	}

	private _evictLRU(): void {
		let oldestKey: string | undefined;
		let oldestTime = Infinity;

		for (const [key, entry] of this._entries) {
			if (entry.lastAccessed < oldestTime) {
				oldestTime = entry.lastAccessed;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this._entries.delete(oldestKey);
		}
	}
}

registerSingleton(INyrveCompletionCache, NyrveCompletionCache, InstantiationType.Delayed);
