/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NyrveModelRouter, NyrveTaskComplexity } from "../model-router.js";
import { INyrveConfigService, NyrveModelId } from "../../core/config.js";

suite("Nyrve: ModelRouter", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createRouter(
		config?: Partial<{
			defaultModel: NyrveModelId;
			complexModel: NyrveModelId;
			backgroundModel: NyrveModelId;
		}>,
	): NyrveModelRouter {
		const configService = new (class extends mock<INyrveConfigService>() {
			override getDefaultModel(): NyrveModelId {
				return config?.defaultModel ?? "claude-sonnet";
			}
			override getComplexTaskModel(): NyrveModelId {
				return config?.complexModel ?? "claude-opus";
			}
			override getBackgroundModel(): NyrveModelId {
				return config?.backgroundModel ?? "claude-haiku";
			}
		})();
		return store.add(new NyrveModelRouter(configService, new NullLogService()));
	}

	test("getApiModelId returns correct Anthropic model strings", () => {
		const router = createRouter();
		assert.strictEqual(router.getApiModelId("claude-opus"), "claude-opus-4-6");
		assert.strictEqual(
			router.getApiModelId("claude-sonnet"),
			"claude-sonnet-4-6",
		);
		assert.strictEqual(
			router.getApiModelId("claude-haiku"),
			"claude-haiku-4-5-20251001",
		);
	});

	test("selectModel maps complexity to model", () => {
		const router = createRouter();
		assert.strictEqual(
			router.selectModel(NyrveTaskComplexity.High),
			"claude-opus",
		);
		assert.strictEqual(
			router.selectModel(NyrveTaskComplexity.Medium),
			"claude-sonnet",
		);
		assert.strictEqual(
			router.selectModel(NyrveTaskComplexity.Low),
			"claude-haiku",
		);
	});

	test("selectModel respects config overrides", () => {
		const router = createRouter({
			defaultModel: "claude-haiku",
			complexModel: "claude-sonnet",
			backgroundModel: "claude-sonnet",
		});
		assert.strictEqual(
			router.selectModel(NyrveTaskComplexity.High),
			"claude-sonnet",
		);
		assert.strictEqual(
			router.selectModel(NyrveTaskComplexity.Medium),
			"claude-haiku",
		);
		assert.strictEqual(
			router.selectModel(NyrveTaskComplexity.Low),
			"claude-sonnet",
		);
	});

	test("getChatModel returns default model", () => {
		const router = createRouter({ defaultModel: "claude-opus" });
		assert.strictEqual(router.getChatModel(), "claude-opus");
	});

	test("getBackgroundModel returns background model", () => {
		const router = createRouter({ backgroundModel: "claude-sonnet" });
		assert.strictEqual(router.getBackgroundModel(), "claude-sonnet");
	});

	test("getAvailableModels returns all three models", () => {
		const router = createRouter();
		const models = router.getAvailableModels();
		assert.deepStrictEqual(models, [
			"claude-opus",
			"claude-sonnet",
			"claude-haiku",
		]);
	});
});
