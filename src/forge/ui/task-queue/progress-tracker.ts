/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../vs/base/common/event.js';
import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';

// --- Types ---

export const enum ProgressActionKind {
	FileRead = 'file_read',
	FileWrite = 'file_write',
	FileCreate = 'file_create',
	TerminalExec = 'terminal_exec',
	Search = 'search',
	ApiCall = 'api_call',
	Thinking = 'thinking',
}

export interface ProgressAction {
	readonly id: string;
	readonly taskId: string;
	readonly kind: ProgressActionKind;
	readonly label: string;
	readonly timestamp: string;
	readonly detail?: string;
}

export interface TaskProgress {
	readonly taskId: string;
	readonly elapsedMs: number;
	readonly actions: readonly ProgressAction[];
	readonly filesRead: readonly string[];
	readonly filesWritten: readonly string[];
	readonly tokensUsed: number;
}

// --- Service Interface ---

export const IForgeProgressTracker = createDecorator<IForgeProgressTracker>('forgeProgressTracker');

export interface IForgeProgressTracker {
	readonly _serviceBrand: undefined;

	readonly onDidLogAction: Event<ProgressAction>;
	readonly onDidUpdateProgress: Event<TaskProgress>;

	/** Start tracking a task. */
	startTracking(taskId: string): void;

	/** Log an action for the current task. */
	logAction(taskId: string, kind: ProgressActionKind, label: string, detail?: string): void;

	/** Record file access. */
	recordFileRead(taskId: string, path: string): void;
	recordFileWrite(taskId: string, path: string): void;

	/** Update token usage. */
	addTokens(taskId: string, tokens: number): void;

	/** Get progress snapshot for a task. */
	getProgress(taskId: string): TaskProgress | undefined;

	/** Stop tracking a task. */
	stopTracking(taskId: string): void;
}

// --- Service Implementation ---

interface TaskTrackingState {
	readonly taskId: string;
	readonly startTime: number;
	readonly actions: ProgressAction[];
	readonly filesRead: Set<string>;
	readonly filesWritten: Set<string>;
	tokensUsed: number;
}

let _actionIdCounter = 0;

export class ForgeProgressTracker extends Disposable implements IForgeProgressTracker {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidLogAction = this._register(new Emitter<ProgressAction>());
	readonly onDidLogAction: Event<ProgressAction> = this._onDidLogAction.event;

	private readonly _onDidUpdateProgress = this._register(new Emitter<TaskProgress>());
	readonly onDidUpdateProgress: Event<TaskProgress> = this._onDidUpdateProgress.event;

	private readonly _tracking = new Map<string, TaskTrackingState>();

	startTracking(taskId: string): void {
		this._tracking.set(taskId, {
			taskId,
			startTime: Date.now(),
			actions: [],
			filesRead: new Set(),
			filesWritten: new Set(),
			tokensUsed: 0,
		});
	}

	logAction(taskId: string, kind: ProgressActionKind, label: string, detail?: string): void {
		const state = this._tracking.get(taskId);
		if (!state) {
			return;
		}

		const action: ProgressAction = {
			id: `action_${++_actionIdCounter}`,
			taskId,
			kind,
			label,
			timestamp: new Date().toISOString(),
			detail,
		};

		state.actions.push(action);
		this._onDidLogAction.fire(action);
		this._fireProgress(state);
	}

	recordFileRead(taskId: string, path: string): void {
		const state = this._tracking.get(taskId);
		if (!state) {
			return;
		}
		state.filesRead.add(path);
		this._fireProgress(state);
	}

	recordFileWrite(taskId: string, path: string): void {
		const state = this._tracking.get(taskId);
		if (!state) {
			return;
		}
		state.filesWritten.add(path);
		this._fireProgress(state);
	}

	addTokens(taskId: string, tokens: number): void {
		const state = this._tracking.get(taskId);
		if (!state) {
			return;
		}
		state.tokensUsed += tokens;
		this._fireProgress(state);
	}

	getProgress(taskId: string): TaskProgress | undefined {
		const state = this._tracking.get(taskId);
		if (!state) {
			return undefined;
		}
		return this._toSnapshot(state);
	}

	stopTracking(taskId: string): void {
		this._tracking.delete(taskId);
	}

	private _fireProgress(state: TaskTrackingState): void {
		this._onDidUpdateProgress.fire(this._toSnapshot(state));
	}

	private _toSnapshot(state: TaskTrackingState): TaskProgress {
		return {
			taskId: state.taskId,
			elapsedMs: Date.now() - state.startTime,
			actions: state.actions,
			filesRead: [...state.filesRead],
			filesWritten: [...state.filesWritten],
			tokensUsed: state.tokensUsed,
		};
	}
}

registerSingleton(IForgeProgressTracker, ForgeProgressTracker, InstantiationType.Delayed);
