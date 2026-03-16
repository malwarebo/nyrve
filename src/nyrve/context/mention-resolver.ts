/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../vs/base/common/uri.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ITextFileService } from '../../vs/workbench/services/textfile/common/textfiles.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { IMarkerService } from '../../vs/platform/markers/common/markers.js';
import { ContextBlock, MentionType } from './context-builder.js';
import { INyrveEditorBridge } from './editor-bridge.js';
import { INyrveIndexManager } from '../indexer/index-manager.js';

// --- Types ---

export interface ParsedMention {
	readonly type: MentionType;
	readonly argument: string | undefined;
	readonly raw: string;
}

// --- Service Interface ---

export const INyrveMentionResolver = createDecorator<INyrveMentionResolver>('nyrveMentionResolver');

export interface INyrveMentionResolver {
	readonly _serviceBrand: undefined;

	/** Parse @-mentions from a user message string. */
	parseMentions(message: string): readonly ParsedMention[];

	/** Resolve a parsed mention to a ContextBlock. */
	resolve(mention: ParsedMention): Promise<ContextBlock | undefined>;

	/** Resolve all mentions in a message. */
	resolveAll(message: string): Promise<readonly ContextBlock[]>;

	/** Strip @-mention syntax from a message, leaving plain text. */
	stripMentions(message: string): string;
}

// --- Service Implementation ---

/** Regex that matches @-mention syntax: @type, @type arg, or @type "quoted arg" */
const MENTION_REGEX = /@(file|folder|symbol|selection|active|open|git-diff|git-staged|git-log|terminal|errors|tests|docs|deps|recent|search|url|image|project)(?:\s+(?:"([^"]+)"|(\S+)))?/g;

export class NyrveMentionResolver extends Disposable implements INyrveMentionResolver {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IMarkerService _markerService: IMarkerService,
		@INyrveEditorBridge private readonly editorBridge: INyrveEditorBridge,
		@INyrveIndexManager private readonly indexManager: INyrveIndexManager,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	parseMentions(message: string): readonly ParsedMention[] {
		const mentions: ParsedMention[] = [];
		let match: RegExpExecArray | null;

		const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
		while ((match = regex.exec(message)) !== null) {
			const type = match[1] as MentionType;
			const argument = match[2] ?? match[3]; // quoted or unquoted arg
			mentions.push({ type, argument, raw: match[0] });
		}

		return mentions;
	}

	async resolve(mention: ParsedMention): Promise<ContextBlock | undefined> {
		try {
			switch (mention.type) {
				case 'file': return await this._resolveFile(mention.argument);
				case 'folder': return await this._resolveFolder(mention.argument);
				case 'symbol': return this._resolveSymbol(mention.argument);
				case 'selection': return this._resolveSelection();
				case 'active': return this._resolveActive();
				case 'open': return this._resolveOpen();
				case 'errors': return this._resolveErrors();
				case 'deps': return await this._resolveDeps();
				case 'project': return this._resolveProject();
				case 'search': return this._resolveSearch(mention.argument);
				case 'recent': return await this._resolveRecent();
				default:
					this.logService.trace(`[Nyrve] Unsupported mention type: ${mention.type}`);
					return undefined;
			}
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to resolve @${mention.type}: ${e}`);
			return undefined;
		}
	}

	async resolveAll(message: string): Promise<readonly ContextBlock[]> {
		const mentions = this.parseMentions(message);
		const blocks: ContextBlock[] = [];

		for (const mention of mentions) {
			const block = await this.resolve(mention);
			if (block) {
				blocks.push(block);
			}
		}

		return blocks;
	}

	stripMentions(message: string): string {
		return message.replace(new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags), '').replace(/\s+/g, ' ').trim();
	}

	// --- Resolvers ---

	private async _resolveFile(filePath: string | undefined): Promise<ContextBlock | undefined> {
		if (!filePath) {
			return undefined;
		}

		const fullPath = this._resolveToWorkspace(filePath);
		const uri = URI.file(fullPath);

		try {
			const content = await this.textFileService.read(uri);
			return this._makeBlock('file', filePath, content.value);
		} catch {
			return this._makeBlock('file', filePath, `[File not found: ${filePath}]`);
		}
	}

	private async _resolveFolder(folderPath: string | undefined): Promise<ContextBlock | undefined> {
		if (!folderPath) {
			return undefined;
		}

		const fullPath = this._resolveToWorkspace(folderPath);
		const uri = URI.file(fullPath);

		try {
			const stat = await this.fileService.resolve(uri);
			if (!stat.children) {
				return this._makeBlock('folder', folderPath, `[Empty or unreadable folder: ${folderPath}]`);
			}

			const tree = stat.children.map(c => {
				const icon = c.isDirectory ? '📁' : '📄';
				return `${icon} ${c.name}`;
			}).join('\n');

			return this._makeBlock('folder', folderPath, `Folder: ${folderPath}\n${tree}`);
		} catch {
			return this._makeBlock('folder', folderPath, `[Folder not found: ${folderPath}]`);
		}
	}

	private _resolveSymbol(symbolName: string | undefined): ContextBlock | undefined {
		if (!symbolName) {
			return undefined;
		}

		const results = this.indexManager.searchSymbols(symbolName, 5);
		if (results.length === 0) {
			return this._makeBlock('symbol', symbolName, `[Symbol not found: ${symbolName}]`);
		}

		const content = results.map(r =>
			`// ${r.filePath}:${r.lineStart}-${r.lineEnd}\n${r.content}`
		).join('\n\n');

		return this._makeBlock('symbol', symbolName, content);
	}

	private _resolveSelection(): ContextBlock | undefined {
		const state = this.editorBridge.getEditorState();
		if (!state.selectedText) {
			return this._makeBlock('selection', 'selection', '[No text selected]');
		}

		const source = state.activeFilePath
			? `${state.activeFilePath}:${state.selection?.startLine}-${state.selection?.endLine}`
			: 'selection';

		return this._makeBlock('selection', source, state.selectedText, {
			language: state.activeFileLanguage,
			lineRange: state.selection ? { start: state.selection.startLine, end: state.selection.endLine } : undefined,
		});
	}

	private _resolveActive(): ContextBlock | undefined {
		const state = this.editorBridge.getEditorState();
		if (!state.activeFilePath) {
			return this._makeBlock('active', 'active', '[No active file]');
		}

		const content = this.editorBridge.getActiveFileContent();
		if (!content) {
			return this._makeBlock('active', state.activeFilePath, '[Could not read active file]');
		}

		return this._makeBlock('active', state.activeFilePath, content, {
			language: state.activeFileLanguage,
		});
	}

	private _resolveOpen(): ContextBlock | undefined {
		const state = this.editorBridge.getEditorState();
		if (state.openTabs.length === 0) {
			return this._makeBlock('open', 'open tabs', '[No open tabs]');
		}

		const content = state.openTabs.map(t => `- ${t}`).join('\n');
		return this._makeBlock('open', 'open tabs', `Open tabs (${state.openTabs.length}):\n${content}`);
	}

	private _resolveErrors(): ContextBlock | undefined {
		const diagnostics = this.editorBridge.getDiagnostics('warning');
		if (diagnostics.length === 0) {
			return this._makeBlock('errors', 'errors', '[No errors or warnings]');
		}

		const content = diagnostics.map(d =>
			`${d.severity.toUpperCase()} ${d.filePath}:${d.line}:${d.column} - ${d.message}${d.source ? ` [${d.source}]` : ''}`
		).join('\n');

		return this._makeBlock('errors', 'errors', `Diagnostics (${diagnostics.length}):\n${content}`);
	}

	private async _resolveDeps(): Promise<ContextBlock | undefined> {
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri;
		if (!projectRoot) {
			return this._makeBlock('deps', 'deps', '[No workspace]');
		}

		const depFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle'];
		const parts: string[] = [];

		for (const fileName of depFiles) {
			const uri = URI.joinPath(projectRoot, fileName);
			try {
				const exists = await this.fileService.exists(uri);
				if (exists) {
					const content = await this.textFileService.read(uri);
					parts.push(`--- ${fileName} ---\n${content.value}`);
				}
			} catch {
				// File doesn't exist or is unreadable
			}
		}

		if (parts.length === 0) {
			return this._makeBlock('deps', 'deps', '[No dependency files found]');
		}

		return this._makeBlock('deps', 'deps', parts.join('\n\n'));
	}

	private _resolveProject(): ContextBlock | undefined {
		const state = this.editorBridge.getEditorState();
		const stats = this.indexManager.getStats();

		const content = [
			`Project root: ${state.projectRoot}`,
			`Indexed files: ${stats.totalFiles}`,
			`Indexed symbols: ${stats.totalSymbols}`,
			`Git branch: ${state.gitBranch ?? 'unknown'}`,
			`Active file: ${state.activeFilePath ?? 'none'}`,
			`Open tabs: ${state.openTabs.length}`,
			`Errors: ${state.diagnostics.filter(d => d.severity === 'error').length}`,
			`Warnings: ${state.diagnostics.filter(d => d.severity === 'warning').length}`,
		].join('\n');

		return this._makeBlock('project', 'project', content);
	}

	private _resolveSearch(query: string | undefined): ContextBlock | undefined {
		if (!query) {
			return this._makeBlock('search', 'search', '[No search query provided]');
		}

		const results = this.indexManager.searchSymbols(query, 10);
		if (results.length === 0) {
			return this._makeBlock('search', query, `[No results for: ${query}]`);
		}

		const content = results.map(r =>
			`// ${r.filePath}:${r.lineStart} (score: ${r.relevanceScore.toFixed(2)})\n${r.content}`
		).join('\n\n');

		return this._makeBlock('search', query, content);
	}

	private async _resolveRecent(): Promise<ContextBlock | undefined> {
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		const recentFiles: string[] = [];

		const stats = this.indexManager.getStats();
		if (stats.totalFiles === 0) {
			return this._makeBlock('recent', 'recent', '[Index not built yet]');
		}

		// Check file entries for recently modified files
		const allFiles = this.indexManager.searchFiles('', 1000);
		for (const filePath of allFiles) {
			const entry = this.indexManager.getFileEntry(filePath);
			if (entry && entry.lastModified > oneDayAgo) {
				recentFiles.push(filePath);
			}
		}

		if (recentFiles.length === 0) {
			return this._makeBlock('recent', 'recent', '[No files modified in the last 24 hours]');
		}

		const content = recentFiles.map(f => `- ${f}`).join('\n');
		return this._makeBlock('recent', 'recent', `Recently modified files (${recentFiles.length}):\n${content}`);
	}

	// --- Helpers ---

	private _resolveToWorkspace(relativePath: string): string {
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri.fsPath ?? '';

		if (relativePath.startsWith('/')) {
			return relativePath;
		}
		return `${projectRoot}/${relativePath}`;
	}

	private _makeBlock(
		type: MentionType,
		source: string,
		content: string,
		metadata?: Partial<ContextBlock['metadata']>
	): ContextBlock {
		return {
			type,
			source,
			content,
			tokenCount: this._estimateTokens(content),
			truncated: false,
			metadata: {
				language: metadata?.language,
				lineRange: metadata?.lineRange,
				lastModified: metadata?.lastModified,
			},
		};
	}

	/** Rough token estimate: ~4 characters per token. */
	private _estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}
}

registerSingleton(INyrveMentionResolver, NyrveMentionResolver, InstantiationType.Delayed);
