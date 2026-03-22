/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../vs/base/test/common/utils.js';
import { mock } from '../../../vs/base/test/common/mock.js';
import { NullLogService } from '../../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../vs/platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../vs/platform/files/common/files.js';
import { IWorkspaceContextService, IWorkspace } from '../../../vs/platform/workspace/common/workspace.js';
import { NyrveMemoryEngine, MemoryType, MemorySource } from '../memory-engine.js';
import { INyrveSqliteStorage } from '../sqlite-storage.js';

suite('Nyrve: MemoryEngine BM25 Search', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createEngine(): NyrveMemoryEngine {
		const fileService = new (class extends mock<IFileService>() {})();
		const workspaceService = new (class extends mock<IWorkspaceContextService>() {
			override getWorkspace(): IWorkspace {
				return { id: 'test', folders: [], transient: false } as IWorkspace;
			}
		})();
		const configService = new TestConfigurationService({ 'nyrve.memory.maxEntries': 1000 });
		const sqliteStorage = new (class extends mock<INyrveSqliteStorage>() {
			override get isReady(): boolean { return false; }
			override async initialize(): Promise<void> { }
		})();
		return store.add(new NyrveMemoryEngine(
			fileService, workspaceService, configService as unknown as IConfigurationService, new NullLogService(), sqliteStorage,
		));
	}

	function add(engine: NyrveMemoryEngine, content: string, tags: string[] = [], confidence: number = 1.0) {
		return engine.addMemory({
			type: MemoryType.Convention,
			content,
			embedding: [],
			source: MemorySource.UserExplicit,
			tags,
			confidence,
			userVerified: true,
		});
	}

	test('ranks exact term matches higher than partial corpus matches', () => {
		const engine = createEngine();
		add(engine, 'PostgreSQL is used for the primary database');
		add(engine, 'Redis is used for caching');
		add(engine, 'Database migrations use Flyway');

		const results = engine.searchByContent('PostgreSQL database');
		assert.ok(results.length >= 1);
		assert.ok(results[0].content.includes('PostgreSQL'));
	});

	test('respects maxResults limit', () => {
		const engine = createEngine();
		for (let i = 0; i < 20; i++) {
			add(engine, `convention number ${i} about testing`);
		}

		const results = engine.searchByContent('testing', 3);
		assert.strictEqual(results.length, 3);
	});

	test('returns empty array for empty query', () => {
		const engine = createEngine();
		add(engine, 'some content');
		assert.strictEqual(engine.searchByContent('').length, 0);
	});

	test('returns empty for stop-word-only query', () => {
		const engine = createEngine();
		add(engine, 'the quick brown fox');
		assert.strictEqual(engine.searchByContent('the is a').length, 0);
	});

	test('blends confidence into ranking', () => {
		const engine = createEngine();
		add(engine, 'TypeScript compiler settings', [], 0.2);
		add(engine, 'TypeScript strict mode enabled', [], 1.0);

		const results = engine.searchByContent('TypeScript');
		assert.strictEqual(results.length, 2);
		// Higher confidence entry should rank first
		assert.ok(results[0].content.includes('strict mode'));
	});

	test('searches tags alongside content', () => {
		const engine = createEngine();
		add(engine, 'project uses monorepo structure', ['architecture', 'monorepo']);
		add(engine, 'unrelated memory', ['other']);

		const results = engine.searchByContent('monorepo');
		assert.strictEqual(results.length, 1);
	});

	test('evicts lowest confidence when at max capacity', () => {
		const smallEngine = (() => {
			const fileService = new (class extends mock<IFileService>() {})();
			const workspaceService = new (class extends mock<IWorkspaceContextService>() {
				override getWorkspace(): IWorkspace {
					return { id: 'test', folders: [], transient: false } as IWorkspace;
				}
			})();
			const configService = new TestConfigurationService({ 'nyrve.memory.maxEntries': 3 });
			const sqliteStorage2 = new (class extends mock<INyrveSqliteStorage>() {
				override get isReady(): boolean { return false; }
				override async initialize(): Promise<void> { }
			})();
			return store.add(new NyrveMemoryEngine(
				fileService, workspaceService, configService as unknown as IConfigurationService, new NullLogService(), sqliteStorage2,
			));
		})();

		add(smallEngine, 'low confidence entry', [], 0.1);
		add(smallEngine, 'medium confidence', [], 0.5);
		add(smallEngine, 'high confidence', [], 0.9);
		add(smallEngine, 'new entry', [], 0.8);

		assert.strictEqual(smallEngine.getAllMemories().length, 3);
		// The low confidence non-verified entry should have been evicted
		const all = smallEngine.getAllMemories();
		assert.ok(all.every(m => m.content !== 'low confidence entry'));
	});
});
