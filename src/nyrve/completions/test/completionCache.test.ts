/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { NyrveCompletionCache, CachedCompletion } from "../completion-cache.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";

suite("Nyrve: CompletionCache", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createCache(
		overrides?: Record<string, unknown>,
	): NyrveCompletionCache {
		const configService = new TestConfigurationService({
			"nyrve.completions.cacheTTL": 30,
			"nyrve.completions.cacheSize": 100,
			...overrides,
		});
		return store.add(
			new NyrveCompletionCache(
				configService as unknown as IConfigurationService,
			),
		);
	}

	function makeCompletion(text: string): CachedCompletion {
		return { text, timestamp: Date.now(), model: "claude-haiku", tokens: 10 };
	}

	test("lookup returns miss for empty cache", () => {
		const cache = createCache();
		const result = cache.lookup("const x = ", ";", "const x = ;");
		assert.strictEqual(result.hit, false);
	});

	test("store and lookup returns hit", () => {
		const cache = createCache();
		const completion = makeCompletion("42");
		cache.store("const x = ", ";", "const x = ;", completion);

		const result = cache.lookup("const x = ", ";", "const x = ;");
		assert.strictEqual(result.hit, true);
		assert.strictEqual(result.completion?.text, "42");
	});

	test("lookup with different key returns miss", () => {
		const cache = createCache();
		cache.store("const x = ", ";", "const x = ;", makeCompletion("42"));

		const result = cache.lookup("let y = ", ";", "let y = ;");
		assert.strictEqual(result.hit, false);
	});

	test("lookupPrefixMatch returns remaining text", () => {
		const cache = createCache();
		cache.store("const x = ", ";", "const x = ;", makeCompletion("foo()"));

		const result = cache.lookupPrefixMatch("const x = f", ";", "const x = f;");
		assert.strictEqual(result.hit, true);
		assert.strictEqual(result.completion?.text, "oo()");
	});

	test("lookupPrefixMatch returns miss when typed text does not match", () => {
		const cache = createCache();
		cache.store("const x = ", ";", "const x = ;", makeCompletion("foo()"));

		const result = cache.lookupPrefixMatch("const x = b", ";", "const x = b;");
		assert.strictEqual(result.hit, false);
	});

	test("clear empties the cache", () => {
		const cache = createCache();
		cache.store("a", "b", "ab", makeCompletion("test"));
		cache.clear();

		const result = cache.lookup("a", "b", "ab");
		assert.strictEqual(result.hit, false);
	});

	test("getStats tracks hits and misses", () => {
		const cache = createCache();
		cache.store("a", "b", "ab", makeCompletion("test"));

		cache.lookup("a", "b", "ab"); // hit
		cache.lookup("c", "d", "cd"); // miss

		const stats = cache.getStats();
		assert.strictEqual(stats.size, 1);
		assert.strictEqual(stats.hits, 1);
		assert.strictEqual(stats.misses, 1);
		assert.strictEqual(stats.hitRate, 0.5);
	});

	test("cache evicts LRU when at capacity", () => {
		const cache = createCache({ "nyrve.completions.cacheSize": 2 });
		cache.store("a", "b", "ab", makeCompletion("first"));
		cache.store("c", "d", "cd", makeCompletion("second"));
		cache.store("e", "f", "ef", makeCompletion("third"));

		const stats = cache.getStats();
		assert.ok(stats.size <= 2);
	});

	test("expired entries return miss", () => {
		const cache = createCache({ "nyrve.completions.cacheTTL": 0 });
		const completion: CachedCompletion = {
			text: "expired",
			timestamp: Date.now() - 60000,
			model: "claude-haiku",
			tokens: 5,
		};
		cache.store("a", "b", "ab", completion);

		const result = cache.lookup("a", "b", "ab");
		assert.strictEqual(result.hit, false);
	});
});
