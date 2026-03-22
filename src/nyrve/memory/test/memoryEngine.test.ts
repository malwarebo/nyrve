/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import {
	NyrveMemoryEngine,
	MemoryType,
	MemorySource,
} from "../memory-engine.js";
import { IFileService } from "../../../vs/platform/files/common/files.js";
import {
	IWorkspaceContextService,
	IWorkspace,
} from "../../../vs/platform/workspace/common/workspace.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";
import { INyrveSqliteStorage } from "../sqlite-storage.js";

suite("Nyrve: MemoryEngine", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createEngine(config?: Record<string, unknown>): NyrveMemoryEngine {
		const fileService = new (class extends mock<IFileService>() {})();
		const workspaceService =
			new (class extends mock<IWorkspaceContextService>() {
				override getWorkspace(): IWorkspace {
					return { id: "test", folders: [], transient: false } as IWorkspace;
				}
			})();
		const configService = new TestConfigurationService({
			"nyrve.memory.maxEntries": 1000,
			...config,
		});
		const sqliteStorage = new (class extends mock<INyrveSqliteStorage>() {
			override get isReady(): boolean { return false; }
			override async initialize(): Promise<void> { }
		})();
		return store.add(
			new NyrveMemoryEngine(
				fileService,
				workspaceService,
				configService as unknown as IConfigurationService,
				new NullLogService(),
				sqliteStorage,
			),
		);
	}

	function addTestMemory(
		engine: NyrveMemoryEngine,
		content: string,
		type?: MemoryType,
		confidence?: number,
	) {
		return engine.addMemory({
			type: type ?? MemoryType.Convention,
			content,
			embedding: [],
			source: MemorySource.UserExplicit,
			tags: [],
			confidence: confidence ?? 1.0,
			userVerified: true,
		});
	}

	test("addMemory creates entry with generated id and timestamps", () => {
		const engine = createEngine();
		const entry = addTestMemory(engine, "use pnpm not npm");

		assert.ok(entry.id.startsWith("mem-"));
		assert.ok(entry.createdAt);
		assert.ok(entry.lastAccessedAt);
		assert.strictEqual(entry.accessCount, 0);
		assert.strictEqual(entry.content, "use pnpm not npm");
	});

	test("addMemory fires onDidAddMemory event", () => {
		const engine = createEngine();
		let firedEntry: typeof engine extends {
			addMemory(...args: infer _): infer R;
		}
			? R
			: never;
		store.add(
			engine.onDidAddMemory((e) => {
				firedEntry = e;
			}),
		);

		const entry = addTestMemory(engine, "test");
		assert.strictEqual(firedEntry!.id, entry.id);
	});

	test("getMemory returns entry and increments access count", () => {
		const engine = createEngine();
		const entry = addTestMemory(engine, "test content");

		const fetched = engine.getMemory(entry.id);
		assert.strictEqual(fetched?.content, "test content");
		assert.strictEqual(fetched?.accessCount, 1);

		engine.getMemory(entry.id);
		assert.strictEqual(engine.getMemory(entry.id)?.accessCount, 3);
	});

	test("getMemory returns undefined for unknown id", () => {
		const engine = createEngine();
		assert.strictEqual(engine.getMemory("nonexistent"), undefined);
	});

	test("deleteMemory removes entry", () => {
		const engine = createEngine();
		const entry = addTestMemory(engine, "to delete");

		engine.deleteMemory(entry.id);
		assert.strictEqual(engine.getMemory(entry.id), undefined);
		assert.strictEqual(engine.getAllMemories().length, 0);
	});

	test("deleteMemory fires onDidDeleteMemory event", () => {
		const engine = createEngine();
		let deletedId: string | undefined;
		store.add(
			engine.onDidDeleteMemory((id) => {
				deletedId = id;
			}),
		);

		const entry = addTestMemory(engine, "to delete");
		engine.deleteMemory(entry.id);
		assert.strictEqual(deletedId, entry.id);
	});

	test("updateMemory modifies entry", () => {
		const engine = createEngine();
		const entry = addTestMemory(engine, "original");

		engine.updateMemory(entry.id, { content: "updated", confidence: 0.5 });

		const fetched = engine.getMemory(entry.id);
		assert.strictEqual(fetched?.content, "updated");
		assert.strictEqual(fetched?.confidence, 0.5);
	});

	test("updateMemory is no-op for unknown id", () => {
		const engine = createEngine();
		engine.updateMemory("nonexistent", { content: "test" });
	});

	test("getAllMemories returns all entries", () => {
		const engine = createEngine();
		addTestMemory(engine, "first");
		addTestMemory(engine, "second");
		addTestMemory(engine, "third");

		assert.strictEqual(engine.getAllMemories().length, 3);
	});

	test("searchByContent finds matching entries", () => {
		const engine = createEngine();
		addTestMemory(engine, "we use TypeScript for frontend");
		addTestMemory(engine, "backend is Python with FastAPI");
		addTestMemory(engine, "testing with Vitest");

		const results = engine.searchByContent("TypeScript");
		assert.strictEqual(results.length, 1);
		assert.ok(results[0].content.includes("TypeScript"));
	});

	test("searchByContent is case-insensitive", () => {
		const engine = createEngine();
		addTestMemory(engine, "We use PNPM for package management");

		const results = engine.searchByContent("pnpm");
		assert.strictEqual(results.length, 1);
	});

	test("searchByType filters correctly", () => {
		const engine = createEngine();
		addTestMemory(engine, "use pnpm", MemoryType.ToolPreference);
		addTestMemory(engine, "tabs not spaces", MemoryType.CodingStyle);
		addTestMemory(engine, "yarn for CI", MemoryType.ToolPreference);

		const results = engine.searchByType(MemoryType.ToolPreference);
		assert.strictEqual(results.length, 2);
	});

	test("getTopMemories returns highest access count entries", () => {
		const engine = createEngine();
		const a = addTestMemory(engine, "popular");
		addTestMemory(engine, "unpopular");

		engine.getMemory(a.id);
		engine.getMemory(a.id);
		engine.getMemory(a.id);

		const top = engine.getTopMemories(1);
		assert.strictEqual(top.length, 1);
		assert.strictEqual(top[0].content, "popular");
	});

	test("getTopMemories excludes low-confidence entries", () => {
		const engine = createEngine();
		addTestMemory(engine, "low confidence", MemoryType.Convention, 0.1);
		addTestMemory(engine, "high confidence", MemoryType.Convention, 0.9);

		const top = engine.getTopMemories(10);
		assert.ok(top.every((m) => m.confidence >= 0.5));
	});

	test("buildMemoryContext returns empty string when no memories", () => {
		const engine = createEngine();
		assert.strictEqual(engine.buildMemoryContext(), "");
	});

	test("buildMemoryContext includes section headers", () => {
		const engine = createEngine();
		addTestMemory(
			engine,
			"modular architecture",
			MemoryType.ArchitectureDecision,
		);

		const context = engine.buildMemoryContext();
		assert.ok(context.includes("## Project Memory"));
		assert.ok(context.includes("### Architecture"));
		assert.ok(context.includes("modular architecture"));
	});

	test("getStats returns correct statistics", () => {
		const engine = createEngine();
		addTestMemory(engine, "first", MemoryType.Convention, 0.8);
		addTestMemory(engine, "second", MemoryType.Convention, 0.6);

		const stats = engine.getStats();
		assert.strictEqual(stats.totalEntries, 2);
		assert.strictEqual(stats.verifiedEntries, 2);
		assert.ok(Math.abs(stats.avgConfidence - 0.7) < 0.01);
	});
});
