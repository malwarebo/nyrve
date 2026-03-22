/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NyrveIndexManager, NyrveIndexState } from "../index-manager.js";
import { IFileService } from "../../../vs/platform/files/common/files.js";
import {
	IWorkspaceContextService,
	IWorkspace,
} from "../../../vs/platform/workspace/common/workspace.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";
import { INyrveIgnoreService } from "../nyrveignore.js";
import {
	INyrveSymbolExtractor,
	NyrveFileSymbols,
	NyrveSymbolKind,
} from "../symbol-extractor.js";

suite("Nyrve: IndexManager", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createMockIgnoreService(): INyrveIgnoreService {
		return new (class extends mock<INyrveIgnoreService>() {
			override isIgnored(filePath: string): boolean {
				return filePath.includes("node_modules") || filePath.includes(".git");
			}
			override exceedsMaxFileSize(size: number): boolean {
				return size > 1048576;
			}
			override async reload(): Promise<void> { }
			override getPatterns(): string[] {
				return [];
			}
		})();
	}

	function createMockSymbolExtractor(): INyrveSymbolExtractor {
		return new (class extends mock<INyrveSymbolExtractor>() {
			override async extractSymbols(
				filePath: string,
			): Promise<NyrveFileSymbols> {
				return {
					filePath,
					language: "typescript",
					symbols: [
						{
							name: "testFunction",
							kind: NyrveSymbolKind.Function,
							filePath,
							lineStart: 1,
							lineEnd: 5,
							signature: "function testFunction(): void",
							containerName: undefined,
						},
					],
				};
			}
		})();
	}

	function createIndexManager(): NyrveIndexManager {
		const fileService = new (class extends mock<IFileService>() {
			override watch() {
				return { dispose() { } };
			}
			override onDidFilesChange = (() => ({ dispose() { } })) as any;
		})();
		const workspaceService =
			new (class extends mock<IWorkspaceContextService>() {
				override getWorkspace(): IWorkspace {
					return {
						id: "test",
						folders: [],
						transient: false,
					} as IWorkspace;
				}
			})();
		const configService = new TestConfigurationService({
			"nyrve.indexer.enabled": true,
			"nyrve.indexer.maxProjectFiles": 50000,
		});

		return store.add(
			new NyrveIndexManager(
				fileService,
				workspaceService,
				createMockIgnoreService() as unknown as INyrveIgnoreService,
				createMockSymbolExtractor() as unknown as INyrveSymbolExtractor,
				configService as unknown as IConfigurationService,
				new NullLogService(),
			),
		);
	}

	test("initial state is Idle", () => {
		const manager = createIndexManager();
		assert.strictEqual(manager.state, NyrveIndexState.Idle);
	});

	test("getStats returns zero counts initially", () => {
		const manager = createIndexManager();
		const stats = manager.getStats();
		assert.strictEqual(stats.totalFiles, 0);
		assert.strictEqual(stats.totalSymbols, 0);
		assert.strictEqual(stats.isIndexing, false);
		assert.strictEqual(stats.lastIndexedAt, undefined);
	});

	test("getFileEntry returns undefined for unknown file", () => {
		const manager = createIndexManager();
		assert.strictEqual(manager.getFileEntry("/unknown.ts"), undefined);
	});

	test("getFileSymbols returns empty array for unknown file", () => {
		const manager = createIndexManager();
		const symbols = manager.getFileSymbols("/unknown.ts");
		assert.strictEqual(symbols.length, 0);
	});

	test("searchSymbols returns empty for no index", () => {
		const manager = createIndexManager();
		const results = manager.searchSymbols("test");
		assert.strictEqual(results.length, 0);
	});

	test("searchFiles returns empty for no index", () => {
		const manager = createIndexManager();
		const results = manager.searchFiles("test");
		assert.strictEqual(results.length, 0);
	});

	test("removeFile does nothing for non-existent file", () => {
		const manager = createIndexManager();
		manager.removeFile("/non-existent.ts");
		assert.strictEqual(manager.getStats().totalFiles, 0);
	});

	test("buildIndex with no workspace folders sets Ready state", async () => {
		const manager = createIndexManager();
		const states: NyrveIndexState[] = [];
		store.add(manager.onDidChangeState((s) => states.push(s)));

		await manager.buildIndex();

		assert.ok(states.includes(NyrveIndexState.Indexing));
		assert.ok(states.includes(NyrveIndexState.Ready));
		assert.strictEqual(manager.state, NyrveIndexState.Ready);
	});

	test("buildIndex skipped when disabled", async () => {
		const fileService = new (class extends mock<IFileService>() {
			override watch() {
				return { dispose() { } };
			}
			override onDidFilesChange = (() => ({ dispose() { } })) as any;
		})();
		const workspaceService =
			new (class extends mock<IWorkspaceContextService>() {
				override getWorkspace(): IWorkspace {
					return { id: "test", folders: [], transient: false } as IWorkspace;
				}
			})();
		const configService = new TestConfigurationService({
			"nyrve.indexer.enabled": false,
		});

		const manager = store.add(
			new NyrveIndexManager(
				fileService,
				workspaceService,
				createMockIgnoreService() as unknown as INyrveIgnoreService,
				createMockSymbolExtractor() as unknown as INyrveSymbolExtractor,
				configService as unknown as IConfigurationService,
				new NullLogService(),
			),
		);

		await manager.buildIndex();
		assert.strictEqual(manager.state, NyrveIndexState.Idle);
	});

	test("onDidChangeState fires on state transitions", () => {
		const manager = createIndexManager();
		const events: NyrveIndexState[] = [];
		store.add(manager.onDidChangeState((s) => events.push(s)));

		// Trigger a buildIndex which will go Idle → Indexing → Ready
		manager.buildIndex();

		// At least Indexing state should fire synchronously
		assert.ok(events.includes(NyrveIndexState.Indexing));
	});

	test("updateFile ignores files in node_modules", async () => {
		const manager = createIndexManager();
		await manager.updateFile("/project/node_modules/pkg/index.js");
		assert.strictEqual(manager.getStats().totalFiles, 0);
	});
});
