/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { INyrveFrameworkDetector } from './framework-detector.js';
import { IWorkspaceContextService } from '../../../vs/platform/workspace/common/workspace.js';
import { IFileService } from '../../../vs/platform/files/common/files.js';
import { URI } from '../../../vs/base/common/uri.js';
import { VSBuffer } from '../../../vs/base/common/buffer.js';
import { NyrveChangeSet } from '../../ui/diff-review/diff-panel.js';

// --- Types ---

export interface TypeDiagnostic {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly message: string;
	readonly code: string;
	readonly severity: 'error' | 'warning';
}

export interface TypeCheckResult {
	readonly status: 'pass' | 'fail' | 'skipped';
	readonly errorsBefore: TypeDiagnostic[];
	readonly errorsAfter: TypeDiagnostic[];
	readonly newErrors: TypeDiagnostic[];
	readonly fixedErrors: TypeDiagnostic[];
	readonly checkerUsed: string;
	readonly duration: number;
}

// --- Service Interface ---

export const INyrveTypeChecker = createDecorator<INyrveTypeChecker>('nyrveTypeChecker');

export interface INyrveTypeChecker {
	readonly _serviceBrand: undefined;

	/** Run the type checker before and after the agent's changes. Returns only NEW errors. */
	check(changeset: NyrveChangeSet): Promise<TypeCheckResult>;
}

// --- Service Implementation ---

export class NyrveTypeChecker extends Disposable implements INyrveTypeChecker {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveFrameworkDetector private readonly frameworkDetector: INyrveFrameworkDetector,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async check(changeset: NyrveChangeSet): Promise<TypeCheckResult> {
		const enabled = this.configurationService.getValue<boolean>('nyrve.verification.runTypeCheck') ?? true;
		if (!enabled) {
			return this._skippedResult('disabled');
		}

		const startTime = Date.now();
		const detection = await this.frameworkDetector.getDetectionResult();
		const config = detection.typeChecker;

		if (!config.detected) {
			return this._skippedResult('no type checker detected');
		}

		const commandOverride = this.configurationService.getValue<string>('nyrve.verification.typeCheckCommand');
		const command = commandOverride || config.command;

		this.logService.info(`[Nyrve] Running type check with ${config.checker}: ${command}`);

		try {
			// Step 1: Write original content → run type checker → capture baseline
			const errorsBefore = await this._runTypeCheckWithContent(command, changeset, 'original');

			// Step 2: Write proposed content → run type checker → capture after
			const errorsAfter = await this._runTypeCheckWithContent(command, changeset, 'proposed');

			// Step 3: Diff the two lists
			const newErrors = this._diffErrors(errorsAfter, errorsBefore);
			const fixedErrors = this._diffErrors(errorsBefore, errorsAfter);

			const duration = Date.now() - startTime;
			const status = newErrors.length > 0 ? 'fail' : 'pass';

			this.logService.info(
				`[Nyrve] Type check ${status}: ${newErrors.length} new errors, ` +
				`${fixedErrors.length} fixed, ${errorsAfter.length} total (${duration}ms)`
			);

			return {
				status,
				errorsBefore,
				errorsAfter,
				newErrors,
				fixedErrors,
				checkerUsed: config.checker,
				duration,
			};
		} catch (error) {
			this.logService.error(`[Nyrve] Type check failed: ${error}`);
			return {
				status: 'fail',
				errorsBefore: [],
				errorsAfter: [],
				newErrors: [],
				fixedErrors: [],
				checkerUsed: config.checker,
				duration: Date.now() - startTime,
			};
		}
	}

	/**
	 * Write either original or proposed content to disk, run the type checker,
	 * then restore the proposed content. This avoids git stash which can
	 * corrupt user state.
	 */
	private async _runTypeCheckWithContent(
		command: string,
		changeset: NyrveChangeSet,
		phase: 'original' | 'proposed',
	): Promise<TypeDiagnostic[]> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			return [];
		}

		const filesToRestore: Array<{ uri: URI; content: string }> = [];

		try {
			// Write the target content to disk
			for (const file of changeset.files) {
				const uri = URI.joinPath(root, file.filePath);
				const contentToWrite = phase === 'original' ? file.originalContent : file.proposedContent;
				const contentToRestore = phase === 'original' ? file.proposedContent : file.proposedContent;
				filesToRestore.push({ uri, content: contentToRestore });
				await this.fileService.writeFile(uri, VSBuffer.fromString(contentToWrite));
			}

			const output = await this._exec(command);
			return this._parseOutput(output, command);
		} catch (error) {
			if (error instanceof CommandResult) {
				return this._parseOutput(error.output, command);
			}
			throw error;
		} finally {
			// Always restore proposed content so we leave files in the agent-modified state
			for (const { uri, content } of filesToRestore) {
				try {
					await this.fileService.writeFile(uri, VSBuffer.fromString(content));
				} catch {
					// Best effort restore
				}
			}
		}
	}

	private _getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private _parseOutput(output: string, command: string): TypeDiagnostic[] {
		if (command.includes('tsc')) {
			return this._parseTscOutput(output);
		}
		if (command.includes('pyright')) {
			return this._parsePyrightOutput(output);
		}
		if (command.includes('mypy')) {
			return this._parseMypyOutput(output);
		}
		if (command.includes('cargo')) {
			return this._parseCargoOutput(output);
		}
		if (command.includes('go vet')) {
			return this._parseGoVetOutput(output);
		}
		return [];
	}

	/** Parse tsc output: `src/foo.ts(12,5): error TS2345: Argument of type...` */
	private _parseTscOutput(output: string): TypeDiagnostic[] {
		const diagnostics: TypeDiagnostic[] = [];
		const pattern = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(output)) !== null) {
			diagnostics.push({
				file: match[1],
				line: parseInt(match[2], 10),
				column: parseInt(match[3], 10),
				severity: match[4] as 'error' | 'warning',
				code: match[5],
				message: match[6],
			});
		}
		return diagnostics;
	}

	/** Parse pyright output: `src/foo.py:12:5 - error: Cannot assign...` */
	private _parsePyrightOutput(output: string): TypeDiagnostic[] {
		const diagnostics: TypeDiagnostic[] = [];
		const pattern = /^(.+):(\d+):(\d+)\s+-\s+(error|warning|information):\s+(.+?)(?:\s+\((.+)\))?$/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(output)) !== null) {
			diagnostics.push({
				file: match[1],
				line: parseInt(match[2], 10),
				column: parseInt(match[3], 10),
				severity: match[4] === 'error' ? 'error' : 'warning',
				code: match[6] ?? '',
				message: match[5],
			});
		}
		return diagnostics;
	}

	/** Parse mypy output: `src/foo.py:12: error: Incompatible types [assignment]` */
	private _parseMypyOutput(output: string): TypeDiagnostic[] {
		const diagnostics: TypeDiagnostic[] = [];
		const pattern = /^(.+):(\d+):\s+(error|warning|note):\s+(.+?)(?:\s+\[(.+)\])?$/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(output)) !== null) {
			if (match[3] === 'note') {
				continue;
			}
			diagnostics.push({
				file: match[1],
				line: parseInt(match[2], 10),
				column: 0,
				severity: match[3] as 'error' | 'warning',
				code: match[5] ?? '',
				message: match[4],
			});
		}
		return diagnostics;
	}

	/** Parse cargo check output (JSON format with `--message-format=json`) */
	private _parseCargoOutput(output: string): TypeDiagnostic[] {
		const diagnostics: TypeDiagnostic[] = [];
		// Cargo outputs one JSON object per line
		for (const line of output.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				const msg = JSON.parse(line);
				if (msg.reason === 'compiler-message' && msg.message) {
					const span = msg.message.spans?.[0];
					if (span) {
						diagnostics.push({
							file: span.file_name ?? '',
							line: span.line_start ?? 0,
							column: span.column_start ?? 0,
							severity: msg.message.level === 'error' ? 'error' : 'warning',
							code: msg.message.code?.code ?? '',
							message: msg.message.message ?? '',
						});
					}
				}
			} catch {
				// Not JSON — try the simple pattern: error[E0308]: mismatched types
				const simplePattern = /^(error|warning)(?:\[(\w+)\])?:\s+(.+)/;
				const match = simplePattern.exec(line);
				if (match) {
					diagnostics.push({
						file: '',
						line: 0,
						column: 0,
						severity: match[1] as 'error' | 'warning',
						code: match[2] ?? '',
						message: match[3],
					});
				}
			}
		}
		return diagnostics;
	}

	/** Parse go vet output: `src/foo.go:12:5: composite literal uses unkeyed fields` */
	private _parseGoVetOutput(output: string): TypeDiagnostic[] {
		const diagnostics: TypeDiagnostic[] = [];
		const pattern = /^(.+\.go):(\d+):(\d+):\s+(.+)$/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(output)) !== null) {
			diagnostics.push({
				file: match[1],
				line: parseInt(match[2], 10),
				column: parseInt(match[3], 10),
				severity: 'error',
				code: '',
				message: match[4],
			});
		}
		return diagnostics;
	}

	/**
	 * Compute errors in `a` that are NOT in `b` (set difference).
	 * Two diagnostics are considered the same if file, line, code, and message match.
	 */
	private _diffErrors(a: TypeDiagnostic[], b: TypeDiagnostic[]): TypeDiagnostic[] {
		const bSet = new Set(b.map(d => `${d.file}:${d.line}:${d.code}:${d.message}`));
		return a.filter(d => !bSet.has(`${d.file}:${d.line}:${d.code}:${d.message}`));
	}

	private _skippedResult(reason: string): TypeCheckResult {
		this.logService.info(`[Nyrve] Type check skipped: ${reason}`);
		return {
			status: 'skipped',
			errorsBefore: [],
			errorsAfter: [],
			newErrors: [],
			fixedErrors: [],
			checkerUsed: '',
			duration: 0,
		};
	}

	private async _exec(command: string): Promise<string> {
		// Use Node.js child_process via the VS Code runtime
		const { exec } = await import('child_process');
		return new Promise<string>((resolve, reject) => {
			const folders = this.workspaceContextService.getWorkspace().folders;
			const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

			exec(command, { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
				const output = stdout + '\n' + stderr;
				if (error) {
					reject(new CommandResult(error.code ?? 1, output));
				} else {
					resolve(output);
				}
			});
		});
	}
}

/** Wraps a failed command execution so we can still parse the output. */
class CommandResult extends Error {
	constructor(
		public readonly exitCode: number,
		public readonly output: string,
	) {
		super(`Command exited with code ${exitCode}`);
	}
}

registerSingleton(INyrveTypeChecker, NyrveTypeChecker, InstantiationType.Delayed);
