/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { Emitter, Event } from "../../../vs/base/common/event.js";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NyrveConfigService, NyrveAgentSettingId } from "../config.js";
import { ISecretStorageService } from "../../../vs/platform/secrets/common/secrets.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";

suite("Nyrve: ConfigService", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createConfigService(
		settings?: Record<string, unknown>,
		secrets?: Record<string, string>,
	): NyrveConfigService {
		const configService = new TestConfigurationService(settings ?? {});

		const secretChangeEmitter = store.add(new Emitter<string>());
		const secretStore = new Map<string, string>(Object.entries(secrets ?? {}));
		const secretStorageService =
			new (class extends mock<ISecretStorageService>() {
				override readonly onDidChangeSecret: Event<string> =
					secretChangeEmitter.event;
				override async get(key: string): Promise<string | undefined> {
					return secretStore.get(key);
				}
				override async set(key: string, value: string): Promise<void> {
					secretStore.set(key, value);
				}
				override async delete(key: string): Promise<void> {
					secretStore.delete(key);
				}
			})();

		return store.add(
			new NyrveConfigService(
				configService as unknown as IConfigurationService,
				secretStorageService,
				new NullLogService(),
			),
		);
	}

	test("getDefaultModel returns configured model", () => {
		const service = createConfigService({
			[NyrveAgentSettingId.DefaultModel]: "claude-opus",
		});
		assert.strictEqual(service.getDefaultModel(), "claude-opus");
	});

	test("getDefaultModel returns claude-sonnet by default", () => {
		const service = createConfigService();
		assert.strictEqual(service.getDefaultModel(), "claude-sonnet");
	});

	test("getComplexTaskModel returns configured model", () => {
		const service = createConfigService({
			[NyrveAgentSettingId.ComplexTaskModel]: "claude-sonnet",
		});
		assert.strictEqual(service.getComplexTaskModel(), "claude-sonnet");
	});

	test("getComplexTaskModel returns claude-opus by default", () => {
		const service = createConfigService();
		assert.strictEqual(service.getComplexTaskModel(), "claude-opus");
	});

	test("getBackgroundModel returns claude-haiku by default", () => {
		const service = createConfigService();
		assert.strictEqual(service.getBackgroundModel(), "claude-haiku");
	});

	test("getConfirmationLevel returns balanced by default", () => {
		const service = createConfigService();
		assert.strictEqual(service.getConfirmationLevel(), "balanced");
	});

	test("getMaxTokensPerRequest returns 100000 by default", () => {
		const service = createConfigService();
		assert.strictEqual(service.getMaxTokensPerRequest(), 100000);
	});

	test("isStreamingEnabled returns true by default", () => {
		const service = createConfigService();
		assert.strictEqual(service.isStreamingEnabled(), true);
	});

	test("getApiKey returns stored key", async () => {
		const service = createConfigService(
			{},
			{ "nyrve.anthropic.apiKey": "sk-ant-test123" },
		);
		const key = await service.getApiKey();
		assert.strictEqual(key, "sk-ant-test123");
	});

	test("getApiKey returns undefined when no key", async () => {
		const service = createConfigService();
		const key = await service.getApiKey();
		assert.strictEqual(key, undefined);
	});

	test("setApiKey stores key", async () => {
		const service = createConfigService();
		await service.setApiKey("sk-ant-newkey");
		const key = await service.getApiKey();
		assert.strictEqual(key, "sk-ant-newkey");
	});

	test("clearApiKey removes key", async () => {
		const service = createConfigService(
			{},
			{ "nyrve.anthropic.apiKey": "sk-ant-test" },
		);
		await service.clearApiKey();
		const key = await service.getApiKey();
		assert.strictEqual(key, undefined);
	});

	test("hasApiKey returns true when key exists", async () => {
		const service = createConfigService(
			{},
			{ "nyrve.anthropic.apiKey": "sk-ant-test" },
		);
		assert.strictEqual(await service.hasApiKey(), true);
	});

	test("hasApiKey returns false when no key", async () => {
		const service = createConfigService();
		assert.strictEqual(await service.hasApiKey(), false);
	});

	test("getSetting returns value", () => {
		const service = createConfigService({ "nyrve.some.setting": 42 });
		assert.strictEqual(service.getSetting<number>("nyrve.some.setting"), 42);
	});

	test("getSetting returns undefined for missing key", () => {
		const service = createConfigService();
		assert.strictEqual(service.getSetting("nonexistent"), undefined);
	});
});
