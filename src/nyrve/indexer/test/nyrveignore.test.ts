/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NyrveIgnoreService } from "../nyrveignore.js";
import { IFileService } from "../../../vs/platform/files/common/files.js";
import {
	IWorkspaceContextService,
	IWorkspace,
} from "../../../vs/platform/workspace/common/workspace.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";

suite("Nyrve: IgnoreService", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createIgnoreService(maxFileSize?: number): NyrveIgnoreService {
		const fileService = new (class extends mock<IFileService>() { })();
		const workspaceService =
			new (class extends mock<IWorkspaceContextService>() {
				override getWorkspace(): IWorkspace {
					return { id: "test", folders: [], transient: false } as IWorkspace;
				}
			})();
		const configService = new TestConfigurationService({
			"nyrve.indexer.maxFileSize": maxFileSize ?? 1048576,
		});
		return store.add(
			new NyrveIgnoreService(
				fileService,
				workspaceService,
				configService as unknown as IConfigurationService,
				new NullLogService(),
			),
		);
	}

	test("isIgnored returns true for node_modules", () => {
		const service = createIgnoreService();
		assert.strictEqual(
			service.isIgnored("project/node_modules/pkg/index.js"),
			true,
		);
	});

	test("isIgnored returns true for .git directory", () => {
		const service = createIgnoreService();
		assert.strictEqual(service.isIgnored(".git/config"), true);
	});

	test("isIgnored returns true for dist directory", () => {
		const service = createIgnoreService();
		assert.strictEqual(service.isIgnored("dist/bundle.js"), true);
	});

	test("isIgnored returns true for binary files", () => {
		const service = createIgnoreService();
		assert.strictEqual(service.isIgnored("assets/logo.png"), true);
		assert.strictEqual(service.isIgnored("fonts/main.woff2"), true);
	});

	test("isIgnored returns true for minified files", () => {
		const service = createIgnoreService();
		assert.strictEqual(service.isIgnored("public/app.min.js"), true);
		assert.strictEqual(service.isIgnored("styles/main.min.css"), true);
	});

	test("isIgnored returns true for lock files", () => {
		const service = createIgnoreService();
		assert.strictEqual(service.isIgnored("package-lock.json"), true);
		assert.strictEqual(service.isIgnored("yarn.lock"), true);
		assert.strictEqual(service.isIgnored("pnpm-lock.yaml"), true);
	});

	test("isIgnored returns false for regular source files", () => {
		const service = createIgnoreService();
		assert.strictEqual(service.isIgnored("src/index.ts"), false);
		assert.strictEqual(service.isIgnored("lib/utils.py"), false);
		assert.strictEqual(service.isIgnored("main.go"), false);
	});

	test("isIgnored normalizes backslashes", () => {
		const service = createIgnoreService();
		assert.strictEqual(
			service.isIgnored("project\\node_modules\\pkg\\index.js"),
			true,
		);
	});

	test("getPatterns returns all default patterns", () => {
		const service = createIgnoreService();
		const patterns = service.getPatterns();
		assert.ok(patterns.length > 40);
		assert.ok(patterns.includes("node_modules/"));
		assert.ok(patterns.includes(".git/"));
	});

	test("exceedsMaxFileSize returns true for files over limit", () => {
		const service = createIgnoreService(1024);
		assert.strictEqual(service.exceedsMaxFileSize(2048), true);
	});

	test("exceedsMaxFileSize returns false for files under limit", () => {
		const service = createIgnoreService(1048576);
		assert.strictEqual(service.exceedsMaxFileSize(500), false);
	});

	test("exceedsMaxFileSize uses default 1MB limit", () => {
		const service = createIgnoreService();
		assert.strictEqual(service.exceedsMaxFileSize(1048576), false);
		assert.strictEqual(service.exceedsMaxFileSize(1048577), true);
	});
});
