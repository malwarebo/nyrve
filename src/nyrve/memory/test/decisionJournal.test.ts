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
import { NyrveDecisionJournal, DecisionEntry } from '../decision-journal.js';
import { INyrveSqliteStorage } from '../sqlite-storage.js';

suite('Nyrve: DecisionJournal', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createJournal(config?: Record<string, unknown>): NyrveDecisionJournal {
		const fileService = new (class extends mock<IFileService>() {
			override readFile(): Promise<never> { return Promise.reject(new Error('File not found')); }
			override writeFile(): Promise<any> { return Promise.resolve(undefined); }
			override exists(): Promise<boolean> { return Promise.resolve(false); }
		})();
		const workspaceService = new (class extends mock<IWorkspaceContextService>() {
			override getWorkspace(): IWorkspace {
				return { id: 'test', folders: [{ uri: { scheme: 'file', path: '/test' } }], transient: false } as any;
			}
		})();
		const configService = new TestConfigurationService({
			'nyrve.memory.decisions.maxEntries': 500,
			...config,
		});

		const sqliteStorage = new (class extends mock<INyrveSqliteStorage>() {
			override get isReady(): boolean { return false; }
			override async initialize(): Promise<void> { }
		})();
		return store.add(new NyrveDecisionJournal(
			fileService,
			configService as unknown as IConfigurationService,
			workspaceService,
			new NullLogService(),
			sqliteStorage,
		));
	}

	function makeDecision(overrides?: Partial<DecisionEntry>): Partial<DecisionEntry> {
		return {
			title: 'Use React for frontend',
			description: 'Chose React over Vue for the frontend framework',
			rationale: 'Team expertise and ecosystem maturity',
			tags: ['frontend', 'framework'],
			modulesAffected: ['ui'],
			filesAffected: ['src/ui/'],
			source: 'conversation',
			status: 'active',
			...overrides,
		};
	}

	test('addDecision creates entry with generated id', async () => {
		const journal = createJournal();
		const id = await journal.addDecision(makeDecision());

		assert.ok(id.startsWith('dec_'));
		const entry = await journal.getDecision(id);
		assert.ok(entry);
		assert.strictEqual(entry.title, 'Use React for frontend');
	});

	test('getDecision returns undefined for unknown id', async () => {
		const journal = createJournal();
		const result = await journal.getDecision('nonexistent');
		assert.strictEqual(result, undefined);
	});

	test('updateDecision modifies entry', async () => {
		const journal = createJournal();
		const id = await journal.addDecision(makeDecision());

		await journal.updateDecision(id, { status: 'superseded' });
		const entry = await journal.getDecision(id);
		assert.strictEqual(entry?.status, 'superseded');
	});

	test('deleteDecision removes entry', async () => {
		const journal = createJournal();
		const id = await journal.addDecision(makeDecision());

		await journal.deleteDecision(id);
		assert.strictEqual(await journal.getDecision(id), undefined);
		assert.strictEqual(journal.getEntryCount(), 0);
	});

	test('searchDecisions ranks title matches higher', async () => {
		const journal = createJournal();
		await journal.addDecision(makeDecision({ title: 'Use PostgreSQL for database', tags: ['database'], description: 'PostgreSQL chosen' }));
		await journal.addDecision(makeDecision({ title: 'Use React for frontend', tags: ['frontend'], description: 'React chosen' }));
		await journal.addDecision(makeDecision({ title: 'API design', tags: ['api'], description: 'mentions React in passing' }));

		const results = await journal.searchDecisions('React');
		assert.ok(results.length >= 1);
		assert.strictEqual(results[0].title, 'Use React for frontend');
	});

	test('searchDecisions returns empty for stop-word-only query', async () => {
		const journal = createJournal();
		await journal.addDecision(makeDecision());

		const results = await journal.searchDecisions('the is a');
		assert.strictEqual(results.length, 0);
	});

	test('searchDecisions excludes superseded entries', async () => {
		const journal = createJournal();
		await journal.addDecision(makeDecision({ title: 'Old React decision', status: 'superseded' }));
		await journal.addDecision(makeDecision({ title: 'New React decision', status: 'active' }));

		const results = await journal.searchDecisions('React');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].title, 'New React decision');
	});

	test('getDecisionsByModule filters by module', async () => {
		const journal = createJournal();
		await journal.addDecision(makeDecision({ modulesAffected: ['agent'] }));
		await journal.addDecision(makeDecision({ modulesAffected: ['ui'] }));

		const results = await journal.getDecisionsByModule('agent');
		assert.strictEqual(results.length, 1);
	});

	test('getDecisionsByTag filters by tag', async () => {
		const journal = createJournal();
		await journal.addDecision(makeDecision({ tags: ['performance'] }));
		await journal.addDecision(makeDecision({ tags: ['security'] }));

		const results = await journal.getDecisionsByTag('performance');
		assert.strictEqual(results.length, 1);
	});

	test('getRecentDecisions filters by date range', async () => {
		const journal = createJournal();
		await journal.addDecision(makeDecision({ date: new Date().toISOString() }));
		await journal.addDecision(makeDecision({ date: '2020-01-01T00:00:00Z' }));

		const results = await journal.getRecentDecisions(7);
		assert.strictEqual(results.length, 1);
	});

	test('evicts oldest entries when exceeding maxEntries', async () => {
		const journal = createJournal({ 'nyrve.memory.decisions.maxEntries': 2 });

		await journal.addDecision(makeDecision({ title: 'First', date: '2024-01-01T00:00:00Z' }));
		await journal.addDecision(makeDecision({ title: 'Second', date: '2024-06-01T00:00:00Z' }));
		await journal.addDecision(makeDecision({ title: 'Third', date: '2025-01-01T00:00:00Z' }));

		assert.strictEqual(journal.getEntryCount(), 2);
		const all = await journal.getAllDecisions();
		assert.ok(all.every(d => d.title !== 'First'));
	});
});
