/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../vs/base/common/uri.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ITextFileService } from '../../vs/workbench/services/textfile/common/textfiles.js';
import { ITerminalService } from '../../vs/workbench/contrib/terminal/browser/terminal.js';
import { ForgeActionType, ForgeConfirmationResult, IForgeConfirmationService } from './confirmation.js';

// --- Types ---

export interface FileReadResult {
	readonly content: string;
	readonly filePath: string;
	readonly language: string | undefined;
}

export interface FileWriteResult {
	readonly filePath: string;
	readonly bytesWritten: number;
}

export interface TerminalCommandResult {
	readonly command: string;
	readonly exitCode: number | undefined;
	readonly output: string;
}

// --- Service Interface ---

export const IForgeActionExecutor = createDecorator<IForgeActionExecutor>('forgeActionExecutor');

export interface IForgeActionExecutor {
	readonly _serviceBrand: undefined;

	/** Read a file's content. Requests confirmation if needed. */
	readFile(filePath: string): Promise<FileReadResult>;

	/**
	 * Write content to a file via the diff review flow.
	 * In non-autonomous mode, changes go to the ForgeDiffService for review.
	 * In autonomous mode, writes directly.
	 */
	writeFile(filePath: string, content: string, description: string): Promise<FileWriteResult>;

	/** Create a new file. Requests confirmation if needed. */
	createFile(filePath: string, content: string, description: string): Promise<FileWriteResult>;

	/** Execute a terminal command. Requests confirmation. */
	executeCommand(command: string, cwd?: string): Promise<TerminalCommandResult>;
}

// --- Service Implementation ---

export class ForgeActionExecutor extends Disposable implements IForgeActionExecutor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IForgeConfirmationService private readonly confirmationService: IForgeConfirmationService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async readFile(filePath: string): Promise<FileReadResult> {
		const result = await this.confirmationService.confirmAction({
			type: ForgeActionType.FileRead,
			description: `Read file: ${filePath}`,
			filePath,
		});

		if (result === ForgeConfirmationResult.Denied) {
			throw new Error(`File read denied by user: ${filePath}`);
		}

		const uri = URI.file(filePath);
		const fileContent = await this.textFileService.read(uri);
		this.logService.trace(`[Forge] Read file: ${filePath} (${fileContent.value.length} chars)`);

		return {
			content: fileContent.value,
			filePath,
			language: undefined, // Could be resolved from model service
		};
	}

	async writeFile(filePath: string, content: string, description: string): Promise<FileWriteResult> {
		const result = await this.confirmationService.confirmAction({
			type: ForgeActionType.FileWrite,
			description,
			filePath,
		});

		if (result === ForgeConfirmationResult.Denied) {
			throw new Error(`File write denied by user: ${filePath}`);
		}

		const uri = URI.file(filePath);
		await this.textFileService.write(uri, content);
		this.logService.info(`[Forge] Wrote file: ${filePath} (${content.length} chars)`);

		return {
			filePath,
			bytesWritten: content.length,
		};
	}

	async createFile(filePath: string, content: string, description: string): Promise<FileWriteResult> {
		const result = await this.confirmationService.confirmAction({
			type: ForgeActionType.FileCreate,
			description,
			filePath,
		});

		if (result === ForgeConfirmationResult.Denied) {
			throw new Error(`File creation denied by user: ${filePath}`);
		}

		const uri = URI.file(filePath);
		await this.fileService.createFile(uri, VSBuffer.fromString(content));
		this.logService.info(`[Forge] Created file: ${filePath} (${content.length} chars)`);

		return {
			filePath,
			bytesWritten: content.length,
		};
	}

	async executeCommand(command: string, cwd?: string): Promise<TerminalCommandResult> {
		const result = await this.confirmationService.confirmAction({
			type: ForgeActionType.TerminalCommand,
			description: `Execute: ${command}`,
			command,
		});

		if (result === ForgeConfirmationResult.Denied) {
			throw new Error(`Command execution denied by user: ${command}`);
		}

		this.logService.info(`[Forge] Executing command: ${command}`);

		const terminal = await this.terminalService.createTerminal({
			cwd: cwd ? URI.file(cwd) : undefined,
		});

		// Collect output
		let output = '';
		const dataListener = this.terminalService.onAnyInstanceData(e => {
			if (e.instance === terminal) {
				output += e.data;
			}
		});

		try {
			await terminal.sendText(command, true);

			// Wait for command to complete (simplified — full implementation would
			// track shell integration events or exit codes)
			await new Promise<void>(resolve => setTimeout(resolve, 2000));

			return {
				command,
				exitCode: undefined, // Terminal instances don't expose exit codes easily
				output,
			};
		} finally {
			dataListener.dispose();
		}
	}
}

registerSingleton(IForgeActionExecutor, ForgeActionExecutor, InstantiationType.Delayed);
