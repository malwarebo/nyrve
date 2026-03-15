/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { localize } from '../../vs/nls.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IDialogService } from '../../vs/platform/dialogs/common/dialogs.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { Severity } from '../../vs/platform/notification/common/notification.js';
import { ForgeConfirmationLevel, IForgeConfigService } from '../core/config.js';

// --- Types ---

export const enum ForgeActionType {
	FileRead = 'file_read',
	FileWrite = 'file_write',
	FileCreate = 'file_create',
	FileDelete = 'file_delete',
	TerminalCommand = 'terminal_command',
	GitOperation = 'git_operation',
}

export interface ForgeActionRequest {
	readonly type: ForgeActionType;
	readonly description: string;
	readonly filePath?: string;
	readonly command?: string;
	readonly detail?: string;
}

export const enum ForgeConfirmationResult {
	Approved = 'approved',
	Denied = 'denied',
	ApproveAll = 'approve_all',
}

// --- Service Interface ---

export const IForgeConfirmationService = createDecorator<IForgeConfirmationService>('forgeConfirmationService');

export interface IForgeConfirmationService {
	readonly _serviceBrand: undefined;

	/**
	 * Request user confirmation for an agent action.
	 * Returns the user's decision based on the current confirmation level.
	 */
	confirmAction(action: ForgeActionRequest): Promise<ForgeConfirmationResult>;

	/**
	 * Check if an action type requires confirmation at the current level.
	 */
	requiresConfirmation(type: ForgeActionType): boolean;
}

// --- Service Implementation ---

/** Actions that are auto-approved in balanced mode. */
const BALANCED_AUTO_APPROVE: ReadonlySet<ForgeActionType> = new Set([
	ForgeActionType.FileRead,
]);

/** Actions that are auto-approved in autonomous mode (all). */
const AUTONOMOUS_AUTO_APPROVE: ReadonlySet<ForgeActionType> = new Set([
	ForgeActionType.FileRead,
	ForgeActionType.FileWrite,
	ForgeActionType.FileCreate,
	ForgeActionType.FileDelete,
	ForgeActionType.TerminalCommand,
	ForgeActionType.GitOperation,
]);

export class ForgeConfirmationService extends Disposable implements IForgeConfirmationService {
	declare readonly _serviceBrand: undefined;

	private _sessionApproveAll = false;

	constructor(
		@IForgeConfigService private readonly configService: IForgeConfigService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async confirmAction(action: ForgeActionRequest): Promise<ForgeConfirmationResult> {
		if (this._sessionApproveAll) {
			this.logService.trace(`[Forge] Action auto-approved (session approve-all): ${action.type}`);
			return ForgeConfirmationResult.Approved;
		}

		if (!this.requiresConfirmation(action.type)) {
			this.logService.trace(`[Forge] Action auto-approved (level): ${action.type}`);
			return ForgeConfirmationResult.Approved;
		}

		const message = this._buildConfirmationMessage(action);
		const detail = action.detail ?? this._buildDetail(action);

		const { result } = await this.dialogService.prompt({
			type: Severity.Info,
			message,
			detail,
			buttons: [
				{
					label: localize('forge.confirm.approve', "Approve"),
					run: () => ForgeConfirmationResult.Approved,
				},
				{
					label: localize('forge.confirm.approveAll', "Approve All (This Session)"),
					run: () => ForgeConfirmationResult.ApproveAll,
				},
			],
			cancelButton: {
				label: localize('forge.confirm.deny', "Deny"),
				run: () => ForgeConfirmationResult.Denied,
			},
		});

		if (result === ForgeConfirmationResult.ApproveAll) {
			this._sessionApproveAll = true;
			return ForgeConfirmationResult.Approved;
		}

		return result ?? ForgeConfirmationResult.Denied;
	}

	requiresConfirmation(type: ForgeActionType): boolean {
		const level = this.configService.getConfirmationLevel();
		return !this._getAutoApproveSet(level).has(type);
	}

	private _getAutoApproveSet(level: ForgeConfirmationLevel): ReadonlySet<ForgeActionType> {
		switch (level) {
			case 'cautious': return new Set<ForgeActionType>();
			case 'balanced': return BALANCED_AUTO_APPROVE;
			case 'autonomous': return AUTONOMOUS_AUTO_APPROVE;
		}
	}

	private _buildConfirmationMessage(action: ForgeActionRequest): string {
		switch (action.type) {
			case ForgeActionType.FileRead:
				return localize('forge.confirm.fileRead', "Forge Agent wants to read a file");
			case ForgeActionType.FileWrite:
				return localize('forge.confirm.fileWrite', "Forge Agent wants to modify a file");
			case ForgeActionType.FileCreate:
				return localize('forge.confirm.fileCreate', "Forge Agent wants to create a file");
			case ForgeActionType.FileDelete:
				return localize('forge.confirm.fileDelete', "Forge Agent wants to delete a file");
			case ForgeActionType.TerminalCommand:
				return localize('forge.confirm.terminalCommand', "Forge Agent wants to run a command");
			case ForgeActionType.GitOperation:
				return localize('forge.confirm.gitOperation', "Forge Agent wants to perform a git operation");
		}
	}

	private _buildDetail(action: ForgeActionRequest): string {
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

registerSingleton(IForgeConfirmationService, ForgeConfirmationService, InstantiationType.Delayed);
