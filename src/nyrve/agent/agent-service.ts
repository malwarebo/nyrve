/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../vs/base/common/cancellation.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, MutableDisposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { NyrveModelId } from '../core/config.js';
import { NyrveAgentResponse, NyrveMessage, NyrveStreamEvent, INyrveAgentEngine } from './agent-engine.js';
import { INyrveModelRouter } from './model-router.js';
import { INyrveVerificationEngine, VerificationProgress } from './verification-engine.js';
import { VerificationReport } from './verification/report-builder.js';
import { INyrveEditorBridge } from '../context/editor-bridge.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { URI } from '../../vs/base/common/uri.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';

// --- Types ---

export const enum NyrveAgentState {
	Idle = 'idle',
	Thinking = 'thinking',
	Streaming = 'streaming',
	Verifying = 'verifying',
	Error = 'error',
}

export interface NyrveConversation {
	readonly id: string;
	readonly messages: NyrveMessage[];
	readonly createdAt: number;
}

// --- Service Interface ---

export const INyrveAgentService = createDecorator<INyrveAgentService>('nyrveAgentService');

export interface INyrveAgentService {
	readonly _serviceBrand: undefined;

	/** Current agent state. */
	readonly state: NyrveAgentState;

	/** Fires when the agent state changes. */
	readonly onDidChangeState: Event<NyrveAgentState>;

	/** Fires on each streaming delta from the agent. */
	readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent>;

	/** Fires when a new message is added to the conversation. */
	readonly onDidAddMessage: Event<NyrveMessage>;

	/** Get the current conversation history. */
	getConversation(): NyrveConversation;

	/** Send a user message and get a streamed response. */
	sendUserMessage(content: string, model?: NyrveModelId): Promise<NyrveAgentResponse>;

	/** Cancel the current in-progress request. */
	cancelCurrentRequest(): void;

	/** Clear the conversation and start a new one. */
	newConversation(): void;

	/** Get the current active model. */
	getActiveModel(): NyrveModelId;

	/** Set the active model for this session. */
	setActiveModel(model: NyrveModelId): void;

	/** Fires during verification pipeline progress. */
	readonly onDidVerificationProgress: Event<VerificationProgress>;

	/** Fires when verification completes with a report. */
	readonly onDidCompleteVerification: Event<VerificationReport>;

	/** Get the most recent verification report, if any. */
	getLastVerificationReport(): VerificationReport | undefined;
}

// --- Service Implementation ---

export class NyrveAgentService extends Disposable implements INyrveAgentService {
	declare readonly _serviceBrand: undefined;

	private _state: NyrveAgentState = NyrveAgentState.Idle;

	private readonly _onDidChangeState = this._register(new Emitter<NyrveAgentState>());
	readonly onDidChangeState: Event<NyrveAgentState> = this._onDidChangeState.event;

	private readonly _onDidReceiveStreamEvent = this._register(new Emitter<NyrveStreamEvent>());
	readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent> = this._onDidReceiveStreamEvent.event;

	private readonly _onDidAddMessage = this._register(new Emitter<NyrveMessage>());
	readonly onDidAddMessage: Event<NyrveMessage> = this._onDidAddMessage.event;

	private readonly messages: NyrveMessage[] = [];
	private readonly conversationId: string;
	private readonly conversationCreatedAt: number;

	private readonly _onDidVerificationProgress = this._register(new Emitter<VerificationProgress>());
	readonly onDidVerificationProgress: Event<VerificationProgress> = this._onDidVerificationProgress.event;

	private readonly _onDidCompleteVerification = this._register(new Emitter<VerificationReport>());
	readonly onDidCompleteVerification: Event<VerificationReport> = this._onDidCompleteVerification.event;

	private readonly currentCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private _activeModel: NyrveModelId | undefined;
	private _lastVerificationReport: VerificationReport | undefined;

	constructor(
		@INyrveAgentEngine private readonly agentEngine: INyrveAgentEngine,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveVerificationEngine private readonly verificationEngine: INyrveVerificationEngine,
		@INyrveEditorBridge private readonly editorBridge: INyrveEditorBridge,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.conversationId = this._generateId();
		this.conversationCreatedAt = Date.now();

		// Forward stream events from the engine
		this._register(this.agentEngine.onDidReceiveStreamEvent(e => {
			if (e.type === 'message_start') {
				this._setState(NyrveAgentState.Streaming);
			}
			this._onDidReceiveStreamEvent.fire(e);
		}));

		// Forward verification progress
		this._register(this.verificationEngine.onDidProgress(p => {
			this._onDidVerificationProgress.fire(p);
		}));
	}

	get state(): NyrveAgentState {
		return this._state;
	}

	getConversation(): NyrveConversation {
		return {
			id: this.conversationId,
			messages: [...this.messages],
			createdAt: this.conversationCreatedAt,
		};
	}

	async sendUserMessage(content: string, model?: NyrveModelId): Promise<NyrveAgentResponse> {
		// Add the user message
		const userMessage: NyrveMessage = {
			role: 'user',
			content,
			timestamp: Date.now(),
		};
		this.messages.push(userMessage);
		this._onDidAddMessage.fire(userMessage);

		this._setState(NyrveAgentState.Thinking);

		const cts = new CancellationTokenSource();
		this.currentCancellation.value = cts;

		try {
			const systemPrompt = await this._buildSystemPrompt();
			const response = await this.agentEngine.sendMessage(
				{
					messages: this.messages,
					model: model ?? this._activeModel,
					systemPrompt,
				},
				cts.token,
			);

			// Add the assistant message
			const assistantMessage: NyrveMessage = {
				role: 'assistant',
				content: response.content,
				timestamp: Date.now(),
				model: response.model,
				tokenUsage: { input: response.inputTokens, output: response.outputTokens },
			};
			this.messages.push(assistantMessage);
			this._onDidAddMessage.fire(assistantMessage);

			this._setState(NyrveAgentState.Idle);
			return response;
		} catch (e) {
			this.logService.error('[Nyrve] Agent request failed:', e);
			this._setState(NyrveAgentState.Error);
			throw e;
		}
	}

	cancelCurrentRequest(): void {
		if (this.currentCancellation.value) {
			this.currentCancellation.value.cancel();
			this._setState(NyrveAgentState.Idle);
			this.logService.info('[Nyrve] Request cancelled');
		}
	}

	newConversation(): void {
		this.messages.length = 0;
		this._setState(NyrveAgentState.Idle);
		this.logService.info('[Nyrve] New conversation started');
	}

	getActiveModel(): NyrveModelId {
		return this._activeModel ?? this.modelRouter.getChatModel();
	}

	setActiveModel(model: NyrveModelId): void {
		this._activeModel = model;
		this.logService.info(`[Nyrve] Active model set to ${model}`);
	}

	getLastVerificationReport(): VerificationReport | undefined {
		return this._lastVerificationReport;
	}

	/**
	 * Run verification on a changeset. Called by the diff review flow after
	 * the agent produces file changes, before showing them to the user.
	 */
	async verifyChangeset(changeset: import('../ui/diff-review/diff-panel.js').NyrveChangeSet): Promise<VerificationReport> {
		this._setState(NyrveAgentState.Verifying);
		try {
			const report = await this.verificationEngine.verify(changeset);
			this._lastVerificationReport = report;
			this._onDidCompleteVerification.fire(report);
			return report;
		} finally {
			this._setState(NyrveAgentState.Idle);
		}
	}

	private _setState(state: NyrveAgentState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	private async _buildSystemPrompt(): Promise<string> {
		const parts: string[] = [
			'You are Nyrve, an AI coding assistant built into the IDE.',
			'You have full awareness of the user\'s editor state, open files, and project context.',
			'Be concise, helpful, and produce high-quality code.',
			'When making code changes, be precise about file paths and line numbers.',
		];

		const state = this.editorBridge.getEditorState();

		// --- Workspace context (always available) ---
		if (state.projectRoot) {
			parts.push('');
			parts.push('## Workspace');
			parts.push(`Project root: ${state.projectRoot}`);

			// Scan workspace file tree
			try {
				const tree = await this._scanWorkspaceTree(state.projectRoot);
				if (tree) {
					parts.push('');
					parts.push('## Project File Tree');
					parts.push(tree);
				}
			} catch (e) {
				this.logService.trace('[Nyrve] Failed to scan workspace tree:', e);
			}

			// Read key project files for context
			try {
				const projectContext = await this._readProjectFiles(state.projectRoot);
				if (projectContext) {
					parts.push('');
					parts.push('## Key Project Files');
					parts.push(projectContext);
				}
			} catch (e) {
				this.logService.trace('[Nyrve] Failed to read project files:', e);
			}
		}

		// --- Editor state ---
		parts.push('');
		parts.push('## Editor State');

		if (state.openTabs.length > 0) {
			parts.push(`Open tabs (${state.openTabs.length}): ${state.openTabs.join(', ')}`);
		}

		if (state.activeFilePath) {
			parts.push(`Active file: ${state.activeFilePath} (${state.activeFileLanguage ?? 'unknown'})`);
			if (state.cursorPosition) {
				parts.push(`Cursor: line ${state.cursorPosition.line}, column ${state.cursorPosition.column}`);
			}

			if (state.selectedText) {
				parts.push(`Selected text:\n\`\`\`\n${state.selectedText}\n\`\`\``);
			}

			const content = this.editorBridge.getActiveFileContent();
			if (content) {
				const maxChars = 50_000;
				const truncated = content.length > maxChars
					? content.slice(0, maxChars) + `\n... (truncated, ${content.length} total chars)`
					: content;
				parts.push(`Active file content:\n\`\`\`${state.activeFileLanguage ?? ''}\n${truncated}\n\`\`\``);
			}
		} else {
			parts.push('No file currently active in the editor.');
		}

		// --- Diagnostics ---
		const errors = state.diagnostics.filter(d => d.severity === 'error');
		const warnings = state.diagnostics.filter(d => d.severity === 'warning');
		if (errors.length > 0 || warnings.length > 0) {
			parts.push('');
			parts.push(`## Diagnostics: ${errors.length} errors, ${warnings.length} warnings`);
			for (const d of errors.slice(0, 10)) {
				parts.push(`  ERROR ${d.filePath}:${d.line} — ${d.message}`);
			}
			for (const d of warnings.slice(0, 5)) {
				parts.push(`  WARN ${d.filePath}:${d.line} — ${d.message}`);
			}
		}

		return parts.join('\n');
	}

	/**
	 * Recursively scan the workspace and return a file tree string.
	 * Skips common non-source directories and binary files.
	 */
	private async _scanWorkspaceTree(projectRoot: string, maxFiles = 500): Promise<string | undefined> {
		const SKIP_DIRS = new Set([
			'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'out-editor-src',
			'out-monaco-editor-core', '.next', '.nuxt', '__pycache__', '.pytest_cache',
			'venv', '.venv', 'env', '.env', '.tox', 'coverage', '.nyc_output',
			'.cache', '.parcel-cache', 'target', '.gradle', '.idea', '.vscode',
			'.nyrve', '.claude', '.devcontainer', 'vendor',
		]);

		const SKIP_EXTENSIONS = new Set([
			'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
			'.woff', '.woff2', '.ttf', '.eot', '.otf',
			'.mp3', '.mp4', '.wav', '.avi', '.mov',
			'.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
			'.pdf', '.doc', '.docx', '.xls', '.xlsx',
			'.exe', '.dll', '.so', '.dylib', '.o', '.a',
			'.lock', '.map',
		]);

		const rootUri = URI.file(projectRoot);
		const lines: string[] = [];
		let fileCount = 0;

		const scan = async (dirUri: URI, prefix: string, depth: number): Promise<void> => {
			if (depth > 6 || fileCount >= maxFiles) {
				return;
			}

			let entries: [string, import('../../vs/platform/files/common/files.js').FileType][];
			try {
				entries = await this.fileService.readdir(dirUri);
			} catch {
				return;
			}

			// Sort: directories first, then files
			entries.sort((a, b) => {
				const aIsDir = a[1] === 2; // FileType.Directory
				const bIsDir = b[1] === 2;
				if (aIsDir !== bIsDir) {
					return aIsDir ? -1 : 1;
				}
				return a[0].localeCompare(b[0]);
			});

			for (const [name, fileType] of entries) {
				if (fileCount >= maxFiles) {
					lines.push(`${prefix}... (truncated at ${maxFiles} files)`);
					return;
				}

				if (name.startsWith('.') && name !== '.env.example') {
					continue;
				}

				const isDir = fileType === 2; // FileType.Directory

				if (isDir) {
					if (SKIP_DIRS.has(name)) {
						continue;
					}
					lines.push(`${prefix}${name}/`);
					const childUri = URI.joinPath(dirUri, name);
					await scan(childUri, prefix + '  ', depth + 1);
				} else {
					const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : '';
					if (SKIP_EXTENSIONS.has(ext)) {
						continue;
					}
					lines.push(`${prefix}${name}`);
					fileCount++;
				}
			}
		};

		await scan(rootUri, '', 0);

		if (lines.length === 0) {
			return undefined;
		}

		return lines.join('\n');
	}

	/**
	 * Read key project files (package.json, README, config files) and return
	 * their contents as context for the agent.
	 */
	private async _readProjectFiles(projectRoot: string): Promise<string | undefined> {
		const KEY_FILES = [
			'package.json',
			'README.md',
			'tsconfig.json',
			'Cargo.toml',
			'pyproject.toml',
			'go.mod',
			'Gemfile',
			'Makefile',
			'docker-compose.yml',
			'Dockerfile',
			'.env.example',
		];

		const parts: string[] = [];
		let totalChars = 0;
		const maxTotalChars = 30_000;

		for (const fileName of KEY_FILES) {
			if (totalChars >= maxTotalChars) {
				break;
			}

			try {
				const fileUri = URI.joinPath(URI.file(projectRoot), fileName);
				const content = await this.fileService.readFile(fileUri);
				const text = VSBuffer.wrap(content.value.buffer).toString();

				if (text.length === 0) {
					continue;
				}

				const remaining = maxTotalChars - totalChars;
				const truncated = text.length > remaining
					? text.slice(0, remaining) + '\n... (truncated)'
					: text;

				parts.push(`### ${fileName}\n\`\`\`\n${truncated}\n\`\`\``);
				totalChars += truncated.length;
			} catch {
				// File doesn't exist — skip
			}
		}

		return parts.length > 0 ? parts.join('\n\n') : undefined;
	}

	private _generateId(): string {
		return `nyrve-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}

registerSingleton(INyrveAgentService, NyrveAgentService, InstantiationType.Delayed);
