/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import {
	NyrveConfirmationService,
	NyrveActionType,
	NyrveConfirmationResult,
} from "../confirmation.js";
import {
	INyrveConfigService,
	NyrveConfirmationLevel,
} from "../../core/config.js";
import { IDialogService } from "../../../vs/platform/dialogs/common/dialogs.js";

suite("Nyrve: ConfirmationService", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(
		level: NyrveConfirmationLevel,
		dialogResult?: NyrveConfirmationResult,
	): NyrveConfirmationService {
		const configService = new (class extends mock<INyrveConfigService>() {
			override getConfirmationLevel(): NyrveConfirmationLevel {
				return level;
			}
		})();
		const dialogService = new (class extends mock<IDialogService>() {
			override async prompt(): Promise<any> {
				return { result: dialogResult ?? NyrveConfirmationResult.Approved };
			}
		})();
		return store.add(
			new NyrveConfirmationService(
				configService,
				dialogService,
				new NullLogService(),
			),
		);
	}

	test("autonomous mode auto-approves all actions", () => {
		const service = createService("autonomous");
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.FileRead),
			false,
		);
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.FileWrite),
			false,
		);
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.TerminalCommand),
			false,
		);
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.GitOperation),
			false,
		);
	});

	test("cautious mode requires confirmation for all actions", () => {
		const service = createService("cautious");
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.FileRead),
			true,
		);
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.FileWrite),
			true,
		);
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.TerminalCommand),
			true,
		);
	});

	test("balanced mode auto-approves only file reads", () => {
		const service = createService("balanced");
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.FileRead),
			false,
		);
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.FileWrite),
			true,
		);
		assert.strictEqual(
			service.requiresConfirmation(NyrveActionType.TerminalCommand),
			true,
		);
	});

	test("confirmAction auto-approves in autonomous mode without dialog", async () => {
		const service = createService("autonomous");
		const result = await service.confirmAction({
			type: NyrveActionType.FileWrite,
			description: "test write",
		});
		assert.strictEqual(result, NyrveConfirmationResult.Approved);
	});

	test("confirmAction shows dialog in cautious mode", async () => {
		const service = createService("cautious", NyrveConfirmationResult.Approved);
		const result = await service.confirmAction({
			type: NyrveActionType.FileRead,
			description: "test read",
		});
		assert.strictEqual(result, NyrveConfirmationResult.Approved);
	});

	test("confirmAction returns denied when dialog is denied", async () => {
		const service = createService("cautious", NyrveConfirmationResult.Denied);
		const result = await service.confirmAction({
			type: NyrveActionType.FileWrite,
			description: "test write",
		});
		assert.strictEqual(result, NyrveConfirmationResult.Denied);
	});

	test("session approve-all bypasses all future confirmations", async () => {
		let dialogCallCount = 0;
		const configService = new (class extends mock<INyrveConfigService>() {
			override getConfirmationLevel(): NyrveConfirmationLevel {
				return "cautious";
			}
		})();
		const dialogService = new (class extends mock<IDialogService>() {
			override async prompt(): Promise<any> {
				dialogCallCount++;
				return { result: NyrveConfirmationResult.ApproveAll };
			}
		})();
		const service = store.add(
			new NyrveConfirmationService(
				configService,
				dialogService,
				new NullLogService(),
			),
		);

		await service.confirmAction({
			type: NyrveActionType.FileWrite,
			description: "first",
		});
		assert.strictEqual(dialogCallCount, 1);

		const result = await service.confirmAction({
			type: NyrveActionType.TerminalCommand,
			description: "second",
		});
		assert.strictEqual(result, NyrveConfirmationResult.Approved);
		assert.strictEqual(dialogCallCount, 1);
	});
});
