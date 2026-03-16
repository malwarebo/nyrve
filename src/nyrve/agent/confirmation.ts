/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { localize } from '../../vs/nls.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IDialogService } from '../../vs/platform/dialogs/common/dialogs.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { Severity } from '../../vs/platform/notification/common/notification.js';
import { NyrveConfirmationLevel, INyrveConfigService } from '../core/config.js';

// --- Types ---

export const enum NyrveActionType {
	FileRead = 'file_read',
	FileWrite = 'file_write',
	FileCreate = 'file_create',
	FileDelete = 'file_delete',
	TerminalCommand = 'terminal_command',
	GitOperation = 'git_operation',
}

export interface NyrveActionRequest {
	readonly type: NyrveActionType;
	readonly description: string;
	readonly filePath?: string;
	readonly command?: string;
	readonly detail?: string;
}

export const enum NyrveConfirmationResult {
	Approved = 'approved',
	Denied = 'denied',
	ApproveAll = 'approve_all',
}

// --- Service Interface ---

export const INyrveConfirmationService = createDecorator<INyrveConfirmationService>('nyrveConfirmationService');

export interface INyrveConfirmationService {
	readonly _serviceBrand: undefined;

	/**
	 * Request user confirmation for an agent action.
	 * Returns the user's decision based on the current confirmation level.
	 */
	confirmAction(action: NyrveActionRequest): Promise<NyrveConfirmationResult>;

	/**
	 * Check if an action type requires confirmation at the current level.
	 */
	requiresConfirmation(type: NyrveActionType): boolean;
}

// --- Service Implementation ---

/** Actions that are auto-approved in balanced mode. */
const BALANCED_AUTO_APPROVE: ReadonlySet<NyrveActionType> = new Set([
	NyrveActionType.FileRead,
]);

/** Actions that are auto-approved in autonomous mode (all). */
const AUTONOMOUS_AUTO_APPROVE: ReadonlySet<NyrveActionType> = new Set([
	NyrveActionType.FileRead,
	NyrveActionType.FileWrite,
	NyrveActionType.FileCreate,
	NyrveActionType.FileDelete,
	NyrveActionType.TerminalCommand,
	NyrveActionType.GitOperation,
]);

export class NyrveConfirmationService extends Disposable implements INyrveConfirmationService {
	declare readonly _serviceBrand: undefined;

	private _sessionApproveAll = false;

	constructor(
		@INyrveConfigService private readonly configService: INyrveConfigService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async confirmAction(action: NyrveActionRequest): Promise<NyrveConfirmationResult> {
		if (this._sessionApproveAll) {
			this.logService.trace(`[Nyrve] Action auto-approved (session approve-all): ${action.type}`);
			return NyrveConfirmationResult.Approved;
		}

		if (!this.requiresConfirmation(action.type)) {
			this.logService.trace(`[Nyrve] Action auto-approved (level): ${action.type}`);
			return NyrveConfirmationResult.Approved;
		}

		const message = this._buildConfirmationMessage(action);
		const detail = action.detail ?? this._buildDetail(action);

		const { result } = await this.dialogService.prompt({
			type: Severity.Info,
			message,
			detail,
			buttons: [
				{
					label: localize('nyrve.confirm.approve', "Approve"),
					run: () => NyrveConfirmationResult.Approved,
				},
				{
					label: localize('nyrve.confirm.approveAll', "Approve All (This Session)"),
					run: () => NyrveConfirmationResult.ApproveAll,
				},
			],
			cancelButton: {
				label: localize('nyrve.confirm.deny', "Deny"),
				run: () => NyrveConfirmationResult.Denied,
			},
		});

		if (result === NyrveConfirmationResult.ApproveAll) {
			this._sessionApproveAll = true;
			return NyrveConfirmationResult.Approved;
		}

		return result ?? NyrveConfirmationResult.Denied;
	}

	requiresConfirmation(type: NyrveActionType): boolean {
		const level = this.configService.getConfirmationLevel();
		return !this._getAutoApproveSet(level).has(type);
	}

	private _getAutoApproveSet(level: NyrveConfirmationLevel): ReadonlySet<NyrveActionType> {
		switch (level) {
			case 'cautious': return new Set<NyrveActionType>();
			case 'balanced': return BALANCED_AUTO_APPROVE;
			case 'autonomous': return AUTONOMOUS_AUTO_APPROVE;
		}
	}

	private _buildConfirmationMessage(action: NyrveActionRequest): string {
		switch (action.type) {
			case NyrveActionType.FileRead:
				return localize('nyrve.confirm.fileRead', "Nyrve Agent wants to read a file");
			case NyrveActionType.FileWrite:
				return localize('nyrve.confirm.fileWrite', "Nyrve Agent wants to modify a file");
			case NyrveActionType.FileCreate:
				return localize('nyrve.confirm.fileCreate', "Nyrve Agent wants to create a file");
			case NyrveActionType.FileDelete:
				return localize('nyrve.confirm.fileDelete', "Nyrve Agent wants to delete a file");
			case NyrveActionType.TerminalCommand:
				return localize('nyrve.confirm.terminalCommand', "Nyrve Agent wants to run a command");
			case NyrveActionType.GitOperation:
				return localize('nyrve.confirm.gitOperation', "Nyrve Agent wants to perform a git operation");
		}
	}

	private _buildDetail(action: NyrveActionRequest): string {
		const parts: string[] = [action.description];
		if (action.filePath) {
			parts.push(`File: ${action.filePath}`);
		}
		if (action.command) {
			parts.push(`Command: ${action.command}`);
		}
		return parts.join('\n');
	}
}

registerSingleton(INyrveConfirmationService, NyrveConfirmationService, InstantiationType.Delayed);
