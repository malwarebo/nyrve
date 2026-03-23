/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../vs/base/test/common/utils.js';
import { mock } from '../../../../vs/base/test/common/mock.js';
import { NullLogService } from '../../../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../../../vs/platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../vs/platform/configuration/test/common/testConfigurationService.js';
import { INyrveAgentEngine, NyrveAgentRequest, NyrveAgentResponse } from '../../agent-engine.js';
import { INyrveModelRouter } from '../../model-router.js';
import { NyrveModelId } from '../../../core/config.js';
import { NyrveSelfHealer, VerificationFailure } from '../self-healer.js';
import { NyrveChangeSet, ChangeSetStatus, HunkStatus } from '../../../ui/diff-review/diff-panel.js';
import { CancellationToken } from '../../../../vs/base/common/cancellation.js';

function makeChangeset(files: Array<{ path: string; content: string }>): NyrveChangeSet {
	return {
		id: 'cs_test',
		description: 'test changeset',
		files: files.map(f => ({
			filePath: f.path,
			originalContent: '',
			proposedContent: f.content,
			hunks: [{
				id: 'hunk_1',
				filePath: f.path,
				startLine: 1,
				endLine: 1,
				originalContent: '',
				proposedContent: f.content,
				status: HunkStatus.Pending,
			}],
		})),
		status: ChangeSetStatus.Proposed,
		createdAt: Date.now(),
	};
}

function makeFailure(file: string, message: string): VerificationFailure {
	return {
		type: 'type_error',
		severity: 'error',
		file,
		message,
		details: message,
	};
}

suite('Nyrve: SelfHealer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHealer(agentResponse: string, config?: Record<string, unknown>): NyrveSelfHealer {
		const agentEngine = new (class extends mock<INyrveAgentEngine>() {
			override async sendMessage(_req: NyrveAgentRequest, _token: CancellationToken): Promise<NyrveAgentResponse> {
				return { content: agentResponse, model: 'claude-sonnet', inputTokens: 100, outputTokens: 200, stopReason: 'end_turn' };
			}
		})();
		const modelRouter = new (class extends mock<INyrveModelRouter>() {
			override getChatModel(): NyrveModelId { return 'claude-sonnet'; }
		})();
		const configService = new TestConfigurationService({
			'nyrve.verification.maxSelfHealAttempts': 3,
			'nyrve.verification.selfHealTimeout': 120000,
			...config,
		});

		return store.add(new NyrveSelfHealer(
			agentEngine,
			modelRouter,
			configService as unknown as IConfigurationService,
			new NullLogService(),
		));
	}

	test('returns could_not_heal when attempt exceeds max', async () => {
		const healer = createHealer('');
		const changeset = makeChangeset([{ path: 'src/a.ts', content: 'old' }]);
		const failures = [makeFailure('src/a.ts', 'type error')];

		const result = await healer.heal(changeset, failures, 4);
		assert.strictEqual(result.status, 'could_not_heal');
		assert.strictEqual(result.remainingFailures.length, 1);
	});

	test('parses FILE blocks from agent response and applies fixes', async () => {
		const agentResponse = [
			'### FILE: src/a.ts',
			'```ts',
			'const x: number = 42;',
			'```',
		].join('\n');

		const healer = createHealer(agentResponse);
		const changeset = makeChangeset([{ path: 'src/a.ts', content: 'const x = "wrong";' }]);
		const failures = [makeFailure('src/a.ts', 'type mismatch')];

		const result = await healer.heal(changeset, failures, 1);
		assert.strictEqual(result.status, 'healed');
		assert.strictEqual(result.fixesApplied.length, 1);
		assert.strictEqual(result.updatedChangeset.files[0].proposedContent, 'const x: number = 42;\n');
	});

	test('rejects fixes that contain .skip() patterns', async () => {
		const agentResponse = [
			'### FILE: src/test.ts',
			'```ts',
			'test.skip("should work", () => {});',
			'```',
		].join('\n');

		const healer = createHealer(agentResponse);
		const changeset = makeChangeset([{ path: 'src/test.ts', content: 'test("should work", () => {});' }]);
		const failures = [makeFailure('src/test.ts', 'test failure')];

		const result = await healer.heal(changeset, failures, 1);
		assert.strictEqual(result.status, 'could_not_heal');
		assert.strictEqual(result.fixesApplied.length, 0);
	});

	test('rejects fixes with pytest.mark.skip', async () => {
		const agentResponse = [
			'### FILE: src/test_foo.py',
			'```python',
			'@pytest.mark.skip',
			'def test_foo(): pass',
			'```',
		].join('\n');

		const healer = createHealer(agentResponse);
		const changeset = makeChangeset([{ path: 'src/test_foo.py', content: 'def test_foo(): assert True' }]);
		const failures = [makeFailure('src/test_foo.py', 'test failure')];

		const result = await healer.heal(changeset, failures, 1);
		assert.strictEqual(result.status, 'could_not_heal');
	});

	test('partially_healed when only some failures are fixed', async () => {
		const agentResponse = [
			'### FILE: src/a.ts',
			'```ts',
			'const x: number = 42;',
			'```',
		].join('\n');

		const healer = createHealer(agentResponse);
		const changeset = makeChangeset([
			{ path: 'src/a.ts', content: 'const x = "wrong";' },
			{ path: 'src/b.ts', content: 'broken' },
		]);
		const failures = [
			makeFailure('src/a.ts', 'type mismatch'),
			makeFailure('src/b.ts', 'syntax error'),
		];

		const result = await healer.heal(changeset, failures, 1);
		assert.strictEqual(result.status, 'partially_healed');
		assert.strictEqual(result.fixesApplied.length, 1);
		assert.strictEqual(result.remainingFailures.length, 1);
		assert.strictEqual(result.remainingFailures[0].file, 'src/b.ts');
	});

	test('ignores FILE blocks for files not in the failure list', async () => {
		const agentResponse = [
			'### FILE: src/unrelated.ts',
			'```ts',
			'console.log("unrelated");',
			'```',
		].join('\n');

		const healer = createHealer(agentResponse);
		const changeset = makeChangeset([{ path: 'src/a.ts', content: 'old' }]);
		const failures = [makeFailure('src/a.ts', 'type error')];

		const result = await healer.heal(changeset, failures, 1);
		assert.strictEqual(result.status, 'could_not_heal');
	});
});
