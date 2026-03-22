/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from "../../vs/base/common/uri.js";
import { VSBuffer } from "../../vs/base/common/buffer.js";
import { Disposable } from "../../vs/base/common/lifecycle.js";
import { createDecorator } from "../../vs/platform/instantiation/common/instantiation.js";
import {
	InstantiationType,
	registerSingleton,
} from "../../vs/platform/instantiation/common/extensions.js";
import { IFileService } from "../../vs/platform/files/common/files.js";
import { ILogService } from "../../vs/platform/log/common/log.js";
import { ITextFileService } from "../../vs/workbench/services/textfile/common/textfiles.js";
import { ITerminalService } from "../../vs/workbench/contrib/terminal/browser/terminal.js";
import { TerminalCapability } from "../../vs/platform/terminal/common/capabilities/capabilities.js";
import {
	NyrveActionType,
	NyrveConfirmationResult,
	INyrveConfirmationService,
} from "./confirmation.js";

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

export const INyrveActionExecutor = createDecorator<INyrveActionExecutor>(
	"nyrveActionExecutor",
);

export interface INyrveActionExecutor {
	readonly _serviceBrand: undefined;

	/** Read a file's content. Requests confirmation if needed. */
	readFile(filePath: string): Promise<FileReadResult>;

	/**
	 * Write content to a file via the diff review flow.
	 * In non-autonomous mode, changes go to the NyrveDiffService for review.
	 * In autonomous mode, writes directly.
	 */
	writeFile(
		filePath: string,
		content: string,
		description: string,
	): Promise<FileWriteResult>;

	/** Create a new file. Requests confirmation if needed. */
	createFile(
		filePath: string,
		content: string,
		description: string,
	): Promise<FileWriteResult>;

	/** Execute a terminal command. Requests confirmation. */
	executeCommand(command: string, cwd?: string): Promise<TerminalCommandResult>;
}

// --- Service Implementation ---

export class NyrveActionExecutor
	extends Disposable
	implements INyrveActionExecutor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveConfirmationService
		private readonly confirmationService: INyrveConfirmationService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async readFile(filePath: string): Promise<FileReadResult> {
		const result = await this.confirmationService.confirmAction({
			type: NyrveActionType.FileRead,
			description: `Read file: ${filePath}`,
			filePath,
		});

		if (result === NyrveConfirmationResult.Denied) {
			throw new Error(`File read denied by user: ${filePath}`);
		}

		const uri = URI.file(filePath);
		const fileContent = await this.textFileService.read(uri);
		this.logService.trace(
			`[Nyrve] Read file: ${filePath} (${fileContent.value.length} chars)`,
		);

		return {
			content: fileContent.value,
			filePath,
			language: undefined, // Could be resolved from model service
		};
	}

	async writeFile(
		filePath: string,
		content: string,
		description: string,
	): Promise<FileWriteResult> {
		const result = await this.confirmationService.confirmAction({
			type: NyrveActionType.FileWrite,
			description,
			filePath,
		});

		if (result === NyrveConfirmationResult.Denied) {
			throw new Error(`File write denied by user: ${filePath}`);
		}

		const uri = URI.file(filePath);
		await this.textFileService.write(uri, content);
		this.logService.info(
			`[Nyrve] Wrote file: ${filePath} (${content.length} chars)`,
		);

		return {
			filePath,
			bytesWritten: content.length,
		};
	}

	async createFile(
		filePath: string,
		content: string,
		description: string,
	): Promise<FileWriteResult> {
		const result = await this.confirmationService.confirmAction({
			type: NyrveActionType.FileCreate,
			description,
			filePath,
		});

		if (result === NyrveConfirmationResult.Denied) {
			throw new Error(`File creation denied by user: ${filePath}`);
		}

		const uri = URI.file(filePath);
		await this.fileService.createFile(uri, VSBuffer.fromString(content));
		this.logService.info(
			`[Nyrve] Created file: ${filePath} (${content.length} chars)`,
		);

		return {
			filePath,
			bytesWritten: content.length,
		};
	}

	async executeCommand(
		command: string,
		cwd?: string,
	): Promise<TerminalCommandResult> {
		const result = await this.confirmationService.confirmAction({
			type: NyrveActionType.TerminalCommand,
			description: `Execute: ${command}`,
			command,
		});

		if (result === NyrveConfirmationResult.Denied) {
			throw new Error(`Command execution denied by user: ${command}`);
		}

		this.logService.info(`[Nyrve] Executing command: ${command}`);

		const terminal = await this.terminalService.createTerminal({
			cwd: cwd ? URI.file(cwd) : undefined,
		});

		let output = "";
		const dataListener = this.terminalService.onAnyInstanceData((e) => {
			if (e.instance === terminal) {
				output += e.data;
			}
		});

		try {
			const commandDetection = terminal.capabilities.get(
				TerminalCapability.CommandDetection,
			);

			if (commandDetection) {
				const exitCode = await this._executeWithShellIntegration(
					terminal,
					command,
					commandDetection,
				);
				return { command, exitCode, output };
			}

			return await this._executeWithTimeout(terminal, command, output);
		} finally {
			dataListener.dispose();
		}
	}

	private async _executeWithShellIntegration(
		terminal: import("../../vs/workbench/contrib/terminal/browser/terminal.js").ITerminalInstance,
		command: string,
		commandDetection: import("../../vs/platform/terminal/common/capabilities/capabilities.js").ICommandDetectionCapability,
	): Promise<number | undefined> {
		return new Promise<number | undefined>((resolve, reject) => {
			const timeout = 120_000;
			const timer = setTimeout(() => {
				listener.dispose();
				this.logService.warn(
					`[Nyrve] Command timed out after ${timeout}ms: ${command}`,
				);
				resolve(undefined);
			}, timeout);

			const listener = commandDetection.onCommandFinished((finishedCommand) => {
				clearTimeout(timer);
				listener.dispose();
				resolve(finishedCommand.exitCode);
			});

			terminal.sendText(command, true).catch((e) => {
				clearTimeout(timer);
				listener.dispose();
				reject(e);
			});
		});
	}

	private async _executeWithTimeout(
		terminal: import("../../vs/workbench/contrib/terminal/browser/terminal.js").ITerminalInstance,
		command: string,
		output: string,
	): Promise<TerminalCommandResult> {
		this.logService.trace(
			"[Nyrve] Shell integration unavailable, falling back to exit-event detection",
		);

		await terminal.sendText(command, true);

		const exitCode = await new Promise<number | undefined>((resolve) => {
			const timeout = 120_000;
			const timer = setTimeout(() => {
				exitListener.dispose();
				resolve(undefined);
			}, timeout);

			const exitListener = terminal.onExit((code) => {
				clearTimeout(timer);
				exitListener.dispose();
				resolve(typeof code === "number" ? code : undefined);
			});
		});

		return { command, exitCode, output };
	}
}

registerSingleton(
	INyrveActionExecutor,
	NyrveActionExecutor,
	InstantiationType.Delayed,
);
