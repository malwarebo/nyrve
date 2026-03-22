/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NyrveMentionRegistry } from "../mention-registry.js";
import { IFileService } from "../../../vs/platform/files/common/files.js";
import {
	IWorkspaceContextService,
	IWorkspace,
} from "../../../vs/platform/workspace/common/workspace.js";

suite("Nyrve: MentionRegistry", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createRegistry(): NyrveMentionRegistry {
		const fileService = new (class extends mock<IFileService>() { })();
		const workspaceService =
			new (class extends mock<IWorkspaceContextService>() {
				override getWorkspace(): IWorkspace {
					return { id: "test", folders: [], transient: false } as IWorkspace;
				}
			})();
		return store.add(
			new NyrveMentionRegistry(
				fileService,
				workspaceService,
				new NullLogService(),
			),
		);
	}

	test("getBuiltInMentions returns 19 built-in mentions", () => {
		const registry = createRegistry();
		const mentions = registry.getBuiltInMentions();
		assert.strictEqual(mentions.length, 19);
	});

	test("getAllMentions includes built-in mentions", () => {
		const registry = createRegistry();
		const all = registry.getAllMentions();
		assert.ok(all.length >= 19);
	});

	test("getCustomMentions is empty initially", () => {
		const registry = createRegistry();
		assert.deepStrictEqual(registry.getCustomMentions(), []);
	});

	test("searchMentions finds mentions by name", () => {
		const registry = createRegistry();
		const results = registry.searchMentions("file");
		assert.ok(results.length > 0);
		assert.ok(results.some((m) => m.name === "file"));
	});

	test("searchMentions finds mentions by description", () => {
		const registry = createRegistry();
		const results = registry.searchMentions("terminal");
		assert.ok(results.some((m) => m.name === "terminal"));
	});

	test("searchMentions is case-insensitive", () => {
		const registry = createRegistry();
		const upper = registry.searchMentions("GIT");
		const lower = registry.searchMentions("git");
		assert.strictEqual(upper.length, lower.length);
	});

	test("searchMentions returns empty for no match", () => {
		const registry = createRegistry();
		const results = registry.searchMentions("xyznonexistent");
		assert.strictEqual(results.length, 0);
	});

	test("built-in mentions have correct structure", () => {
		const registry = createRegistry();
		for (const m of registry.getBuiltInMentions()) {
			assert.ok(m.type, `mention ${m.name} missing type`);
			assert.ok(m.name, `mention ${m.name} missing name`);
			assert.ok(m.description, `mention ${m.name} missing description`);
			assert.ok(m.syntax, `mention ${m.name} missing syntax`);
			assert.strictEqual(m.isBuiltIn, true);
		}
	});

	test("file-based mentions have hasArgument=true", () => {
		const registry = createRegistry();
		const fileMention = registry
			.getBuiltInMentions()
			.find((m) => m.name === "file");
		assert.strictEqual(fileMention?.hasArgument, true);
		assert.ok(fileMention?.argumentHint);
	});

	test("selection mention has hasArgument=false", () => {
		const registry = createRegistry();
		const selMention = registry
			.getBuiltInMentions()
			.find((m) => m.name === "selection");
		assert.strictEqual(selMention?.hasArgument, false);
	});
});
