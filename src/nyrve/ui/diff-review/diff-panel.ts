/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../vs/base/common/uri.js';
import { Event, Emitter } from '../../../vs/base/common/event.js';
import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../../vs/platform/files/common/files.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IEditorService } from '../../../vs/workbench/services/editor/common/editorService.js';
import { ITextFileService } from '../../../vs/workbench/services/textfile/common/textfiles.js';
import { IUndoRedoService, UndoRedoElementType } from '../../../vs/platform/undoRedo/common/undoRedo.js';

// --- Types ---

export const enum ChangeSetStatus {
	Proposed = 'PROPOSED',
	Reviewing = 'REVIEWING',
	PartiallyAccepted = 'PARTIALLY_ACCEPTED',
	Applied = 'APPLIED',
	Rejected = 'REJECTED',
	RevisionRequested = 'REVISION_REQUESTED',
}

export const enum HunkStatus {
	Pending = 'pending',
	Accepted = 'accepted',
	Rejected = 'rejected',
}

export interface NyrveHunk {
	readonly id: string;
	readonly filePath: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly originalContent: string;
	readonly proposedContent: string;
	status: HunkStatus;
}

export interface NyrveFileChange {
	readonly filePath: string;
	readonly originalContent: string;
	readonly proposedContent: string;
	readonly hunks: NyrveHunk[];
}

export interface NyrveChangeSet {
	readonly id: string;
	readonly description: string;
	readonly files: NyrveFileChange[];
	status: ChangeSetStatus;
	readonly createdAt: number;
}

// --- Service Interface ---

export const INyrveDiffService = createDecorator<INyrveDiffService>('nyrveDiffService');

export interface INyrveDiffService {
	readonly _serviceBrand: undefined;

	/** Fires when a changeset is proposed. */
	readonly onDidProposeChangeSet: Event<NyrveChangeSet>;

	/** Fires when a changeset status changes. */
	readonly onDidChangeStatus: Event<NyrveChangeSet>;

	/** Fires when a hunk status changes. */
	readonly onDidChangeHunkStatus: Event<NyrveHunk>;

	/** Get the current active changeset, if any. */
	getActiveChangeSet(): NyrveChangeSet | undefined;

	/**
	 * Propose a new set of file changes from the agent.
	 * Creates shadow buffers and opens the diff review flow.
	 */
	proposeChanges(description: string, changes: Array<{ filePath: string; proposedContent: string }>): Promise<NyrveChangeSet>;

	/** Accept a single hunk. */
	acceptHunk(changeSetId: string, hunkId: string): Promise<void>;

	/** Reject a single hunk. */
	rejectHunk(changeSetId: string, hunkId: string): void;

	/** Accept all pending hunks across all files. */
	acceptAll(changeSetId: string): Promise<void>;

	/** Reject all pending hunks. */
	rejectAll(changeSetId: string): void;

	/** Open the diff view for a specific file change. */
	openDiffForFile(changeSetId: string, filePath: string): Promise<void>;

	/** Get all hunks for a changeset. */
	getHunks(changeSetId: string): readonly NyrveHunk[];

	/** Get pending hunk count. */
	getPendingHunkCount(changeSetId: string): number;
}

// --- Service Implementation ---

export class NyrveDiffService extends Disposable implements INyrveDiffService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidProposeChangeSet = this._register(new Emitter<NyrveChangeSet>());
	readonly onDidProposeChangeSet: Event<NyrveChangeSet> = this._onDidProposeChangeSet.event;

	private readonly _onDidChangeStatus = this._register(new Emitter<NyrveChangeSet>());
	readonly onDidChangeStatus: Event<NyrveChangeSet> = this._onDidChangeStatus.event;

	private readonly _onDidChangeHunkStatus = this._register(new Emitter<NyrveHunk>());
	readonly onDidChangeHunkStatus: Event<NyrveHunk> = this._onDidChangeHunkStatus.event;

	private activeChangeSet: NyrveChangeSet | undefined;
	private readonly changeSets = new Map<string, NyrveChangeSet>();

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IFileService private readonly fileService: IFileService,
		@IUndoRedoService private readonly undoRedoService: IUndoRedoService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getActiveChangeSet(): NyrveChangeSet | undefined {
		return this.activeChangeSet;
	}

	async proposeChanges(description: string, changes: Array<{ filePath: string; proposedContent: string }>): Promise<NyrveChangeSet> {
		const files: NyrveFileChange[] = [];

		for (const change of changes) {
			const uri = URI.file(change.filePath);
			let originalContent = '';

			try {
				const exists = await this.fileService.exists(uri);
				if (exists) {
					const file = await this.textFileService.read(uri);
					originalContent = file.value;
				}
			} catch {
				// New file — original is empty
			}

			const hunks = this._computeHunks(change.filePath, originalContent, change.proposedContent);

			files.push({
				filePath: change.filePath,
				originalContent,
				proposedContent: change.proposedContent,
				hunks,
			});
		}

		const changeSet: NyrveChangeSet = {
			id: this._generateId(),
			description,
			files,
			status: ChangeSetStatus.Proposed,
			createdAt: Date.now(),
		};

		this.changeSets.set(changeSet.id, changeSet);
		this.activeChangeSet = changeSet;

		this.logService.info(`[Nyrve] Proposed changeset ${changeSet.id}: ${files.length} files, ${files.reduce((n, f) => n + f.hunks.length, 0)} hunks`);
		this._onDidProposeChangeSet.fire(changeSet);

		// Auto-open diff for first file
		if (files.length > 0) {
			await this.openDiffForFile(changeSet.id, files[0].filePath);
		}

		return changeSet;
	}

	async acceptHunk(changeSetId: string, hunkId: string): Promise<void> {
		const changeSet = this.changeSets.get(changeSetId);
		if (!changeSet) {
			return;
		}

		for (const file of changeSet.files) {
			const hunk = file.hunks.find(h => h.id === hunkId);
			if (hunk && hunk.status === HunkStatus.Pending) {
				hunk.status = HunkStatus.Accepted;
				this._onDidChangeHunkStatus.fire(hunk);
				this.logService.trace(`[Nyrve] Accepted hunk ${hunkId} in ${file.filePath}`);

				// Apply the accepted hunk to the file
				await this._applyHunk(file, hunk);
				break;
			}
		}

		this._updateChangeSetStatus(changeSet);
	}

	rejectHunk(changeSetId: string, hunkId: string): void {
		const changeSet = this.changeSets.get(changeSetId);
		if (!changeSet) {
			return;
		}

		for (const file of changeSet.files) {
			const hunk = file.hunks.find(h => h.id === hunkId);
			if (hunk && hunk.status === HunkStatus.Pending) {
				hunk.status = HunkStatus.Rejected;
				this._onDidChangeHunkStatus.fire(hunk);
				this.logService.trace(`[Nyrve] Rejected hunk ${hunkId} in ${file.filePath}`);
				break;
			}
		}

		this._updateChangeSetStatus(changeSet);
	}

	async acceptAll(changeSetId: string): Promise<void> {
		const changeSet = this.changeSets.get(changeSetId);
		if (!changeSet) {
			return;
		}

		for (const file of changeSet.files) {
			// For accept-all, write the full proposed content
			const uri = URI.file(file.filePath);
			const originalContent = file.originalContent;

			await this.textFileService.write(uri, file.proposedContent);

			// Push undo element
			this.undoRedoService.pushElement({
				type: UndoRedoElementType.Resource,
				resource: uri,
				label: `Nyrve: ${changeSet.description}`,
				code: 'nyrve.acceptChanges',
				undo: async () => {
					await this.textFileService.write(uri, originalContent);
				},
				redo: async () => {
					await this.textFileService.write(uri, file.proposedContent);
				},
			});

			for (const hunk of file.hunks) {
				if (hunk.status === HunkStatus.Pending) {
					hunk.status = HunkStatus.Accepted;
					this._onDidChangeHunkStatus.fire(hunk);
				}
			}
		}

		changeSet.status = ChangeSetStatus.Applied;
		this._onDidChangeStatus.fire(changeSet);
		this.logService.info(`[Nyrve] Accepted all changes in changeset ${changeSetId}`);
	}

	rejectAll(changeSetId: string): void {
		const changeSet = this.changeSets.get(changeSetId);
		if (!changeSet) {
			return;
		}

		for (const file of changeSet.files) {
			for (const hunk of file.hunks) {
				if (hunk.status === HunkStatus.Pending) {
					hunk.status = HunkStatus.Rejected;
					this._onDidChangeHunkStatus.fire(hunk);
				}
			}
		}

		changeSet.status = ChangeSetStatus.Rejected;
		this._onDidChangeStatus.fire(changeSet);
		this.logService.info(`[Nyrve] Rejected all changes in changeset ${changeSetId}`);
	}

	async openDiffForFile(changeSetId: string, filePath: string): Promise<void> {
		const changeSet = this.changeSets.get(changeSetId);
		if (!changeSet) {
			return;
		}

		const file = changeSet.files.find(f => f.filePath === filePath);
		if (!file) {
			return;
		}

		changeSet.status = ChangeSetStatus.Reviewing;
		this._onDidChangeStatus.fire(changeSet);

		// Open VS Code's built-in diff editor using original vs proposed URIs
		const originalUri = URI.file(filePath);
		const proposedUri = URI.file(filePath).with({ scheme: 'nyrve-proposed' });

		await this.editorService.openEditor({
			original: { resource: originalUri },
			modified: { resource: proposedUri },
			label: `Nyrve: ${filePath}`,
		});
	}

	getHunks(changeSetId: string): readonly NyrveHunk[] {
		const changeSet = this.changeSets.get(changeSetId);
		if (!changeSet) {
			return [];
		}
		return changeSet.files.flatMap(f => f.hunks);
	}

	getPendingHunkCount(changeSetId: string): number {
		return this.getHunks(changeSetId).filter(h => h.status === HunkStatus.Pending).length;
	}

	private async _applyHunk(file: NyrveFileChange, hunk: NyrveHunk): Promise<void> {
		const uri = URI.file(file.filePath);
		const originalContent = file.originalContent;

		// Apply just this hunk by replacing the line range
		const lines = originalContent.split('\n');
		const proposedLines = hunk.proposedContent.split('\n');

		lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...proposedLines);

		const newContent = lines.join('\n');
		await this.textFileService.write(uri, newContent);

		// Push undo element for this specific hunk
		this.undoRedoService.pushElement({
			type: UndoRedoElementType.Resource,
			resource: uri,
			label: `Nyrve: Accept hunk in ${file.filePath}`,
			code: 'nyrve.acceptHunk',
			undo: async () => {
				await this.textFileService.write(uri, originalContent);
			},
			redo: async () => {
				await this.textFileService.write(uri, newContent);
			},
		});
	}

	private _updateChangeSetStatus(changeSet: NyrveChangeSet): void {
		const allHunks = changeSet.files.flatMap(f => f.hunks);
		const pending = allHunks.filter(h => h.status === HunkStatus.Pending);
		const accepted = allHunks.filter(h => h.status === HunkStatus.Accepted);
		const rejected = allHunks.filter(h => h.status === HunkStatus.Rejected);

		if (pending.length === 0) {
			if (rejected.length === allHunks.length) {
				changeSet.status = ChangeSetStatus.Rejected;
			} else {
				changeSet.status = ChangeSetStatus.Applied;
			}
		} else if (accepted.length > 0 || rejected.length > 0) {
			changeSet.status = ChangeSetStatus.PartiallyAccepted;
		}

		this._onDidChangeStatus.fire(changeSet);
	}

	/**
	 * Compute hunks by splitting changes at unchanged line boundaries.
	 * Simplified line-based diffing — groups consecutive changed lines into hunks.
	 */
	private _computeHunks(filePath: string, original: string, proposed: string): NyrveHunk[] {
		const originalLines = original.split('\n');
		const proposedLines = proposed.split('\n');
		const hunks: NyrveHunk[] = [];

		let i = 0;
		while (i < Math.max(originalLines.length, proposedLines.length)) {
			// Skip matching lines
			if (i < originalLines.length && i < proposedLines.length && originalLines[i] === proposedLines[i]) {
				i++;
				continue;
			}

			// Found a difference — find the extent of this hunk
			const hunkStart = i;
			while (i < Math.max(originalLines.length, proposedLines.length)) {
				if (i < originalLines.length && i < proposedLines.length && originalLines[i] === proposedLines[i]) {
					break;
				}
				i++;
			}
			const hunkEnd = i - 1;

			const originalChunk = originalLines.slice(hunkStart, hunkEnd + 1).join('\n');
			const proposedChunk = proposedLines.slice(hunkStart, hunkEnd + 1).join('\n');

			hunks.push({
				id: `hunk-${filePath}-${hunkStart}`,
				filePath,
				startLine: hunkStart + 1, // 1-indexed
				endLine: hunkEnd + 1,
				originalContent: originalChunk,
				proposedContent: proposedChunk,
				status: HunkStatus.Pending,
			});
		}

		return hunks;
	}

	private _generateId(): string {
		return `cs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}

registerSingleton(INyrveDiffService, NyrveDiffService, InstantiationType.Delayed);
