/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NyrveMemoryExtractor } from "../memory-extractor.js";
import {
	INyrveMemoryEngine,
	MemoryEntry,
	MemoryType,
	MemorySource,
} from "../memory-engine.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";

suite("Nyrve: MemoryExtractor", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let addedMemories: Array<
		Omit<MemoryEntry, "id" | "createdAt" | "lastAccessedAt" | "accessCount">
	>;

	function createExtractor(
		config?: Record<string, unknown>,
	): NyrveMemoryExtractor {
		addedMemories = [];
		const memoryEngine = new (class extends mock<INyrveMemoryEngine>() {
			override addMemory(
				entry: Omit<
					MemoryEntry,
					"id" | "createdAt" | "lastAccessedAt" | "accessCount"
				>,
			): MemoryEntry {
				addedMemories.push(entry);
				return {
					...entry,
					id: `mem-test-${addedMemories.length}`,
					createdAt: new Date().toISOString(),
					lastAccessedAt: new Date().toISOString(),
					accessCount: 0,
				};
			}
		})();
		const configService = new TestConfigurationService({
			"nyrve.memory.autoExtract": true,
			...config,
		});
		return store.add(
			new NyrveMemoryExtractor(
				memoryEngine,
				configService as unknown as IConfigurationService,
				new NullLogService(),
			),
		);
	}

	test('extractFromConversation detects "remember that" pattern', () => {
		const extractor = createExtractor();
		extractor.extractFromConversation([
			{
				role: "user",
				content: "Remember that we use pnpm for package management",
			},
		]);
		assert.strictEqual(addedMemories.length, 1);
		assert.strictEqual(
			addedMemories[0].content,
			"we use pnpm for package management",
		);
	});

	test('extractFromConversation detects "note that" pattern', () => {
		const extractor = createExtractor();
		extractor.extractFromConversation([
			{ role: "user", content: "Note that the API uses GraphQL" },
		]);
		assert.strictEqual(addedMemories.length, 1);
		assert.ok(addedMemories[0].content.includes("API uses GraphQL"));
	});

	test('extractFromConversation detects "keep in mind that" pattern', () => {
		const extractor = createExtractor();
		extractor.extractFromConversation([
			{ role: "user", content: "Keep in mind that tests run with Vitest" },
		]);
		assert.strictEqual(addedMemories.length, 1);
	});

	test("extractFromConversation ignores assistant messages", () => {
		const extractor = createExtractor();
		extractor.extractFromConversation([
			{ role: "assistant", content: "Remember that you asked about X" },
		]);
		assert.strictEqual(addedMemories.length, 0);
	});

	test("extractFromConversation is no-op when autoExtract is disabled", () => {
		const extractor = createExtractor({ "nyrve.memory.autoExtract": false });
		extractor.extractFromConversation([
			{ role: "user", content: "Remember that we use tabs" },
		]);
		assert.strictEqual(addedMemories.length, 0);
	});

	test("processExplicitMemory classifies tool preferences", () => {
		const extractor = createExtractor();
		extractor.processExplicitMemory(
			"our tool chain is pnpm for package management",
		);
		assert.strictEqual(addedMemories.length, 1);
		assert.strictEqual(addedMemories[0].type, MemoryType.ToolPreference);
	});

	test("processExplicitMemory classifies architecture decisions", () => {
		const extractor = createExtractor();
		extractor.processExplicitMemory(
			"we decided to use microservices because of scalability",
		);
		assert.strictEqual(addedMemories[0].type, MemoryType.ArchitectureDecision);
	});

	test("processExplicitMemory classifies coding style", () => {
		const extractor = createExtractor();
		extractor.processExplicitMemory(
			"we prefer functional components over class components",
		);
		assert.strictEqual(addedMemories[0].type, MemoryType.CodingStyle);
	});

	test("processExplicitMemory classifies bug context", () => {
		const extractor = createExtractor();
		extractor.processExplicitMemory(
			"there is a flaky bug in the payment module",
		);
		assert.strictEqual(addedMemories[0].type, MemoryType.BugContext);
	});

	test("processExplicitMemory defaults to Convention for unclassified content", () => {
		const extractor = createExtractor();
		extractor.processExplicitMemory("version 3 was released last week");
		assert.strictEqual(addedMemories[0].type, MemoryType.Convention);
	});

	test("processExplicitMemory extracts technology tags", () => {
		const extractor = createExtractor();
		extractor.processExplicitMemory(
			"the frontend uses react and typescript with tailwind",
		);
		assert.ok(addedMemories[0].tags.includes("react"));
		assert.ok(addedMemories[0].tags.includes("typescript"));
		assert.ok(addedMemories[0].tags.includes("tailwind"));
	});

	test("processExplicitMemory sets high confidence and userVerified", () => {
		const extractor = createExtractor();
		extractor.processExplicitMemory("test content");
		assert.strictEqual(addedMemories[0].confidence, 1.0);
		assert.strictEqual(addedMemories[0].userVerified, true);
		assert.strictEqual(addedMemories[0].source, MemorySource.UserExplicit);
	});
});
