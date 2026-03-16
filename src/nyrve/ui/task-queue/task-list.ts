/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { INyrveTaskQueue, Task, TaskStatus } from './task-panel.js';

/**
 * Renders a list of tasks with status indicators and action buttons.
 * Used as a child component inside the task queue view.
 */
export class NyrveTaskListRenderer extends Disposable {

	private readonly _itemDisposables = this._register(new DisposableStore());
	private readonly _container: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly taskQueue: INyrveTaskQueue,
	) {
		super();
		this._container = document.createElement('div');
		this._container.className = 'nyrve-task-list';
		parent.appendChild(this._container);

		this._register(this.taskQueue.onDidAddTask(() => this._render()));
		this._register(this.taskQueue.onDidUpdateTask(() => this._render()));
		this._register(this.taskQueue.onDidRemoveTask(() => this._render()));

		this._render();
	}

	private _render(): void {
		this._itemDisposables.clear();
		this._container.textContent = '';

		const tasks = this.taskQueue.getTasks();

		if (tasks.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'nyrve-task-list-empty';
			empty.textContent = 'No tasks in queue';
			this._container.appendChild(empty);
			return;
		}

		for (const task of tasks) {
			this._container.appendChild(this._renderTaskItem(task));
		}
	}

	private _renderTaskItem(task: Task): HTMLElement {
		const row = document.createElement('div');
		row.className = `nyrve-task-item nyrve-task-status-${task.status.toLowerCase()}`;

		// Status badge
		const badge = document.createElement('span');
		badge.className = 'nyrve-task-badge';
		badge.textContent = this._statusLabel(task.status);
		row.appendChild(badge);

		// Title
		const title = document.createElement('span');
		title.className = 'nyrve-task-title';
		title.textContent = task.title;
		row.appendChild(title);

		// Actions
		const actions = document.createElement('span');
		actions.className = 'nyrve-task-actions';

		if (task.status === TaskStatus.InProgress) {
			actions.appendChild(this._actionButton('Pause', () => this.taskQueue.pauseTask(task.id)));
			actions.appendChild(this._actionButton('Cancel', () => this.taskQueue.cancelTask(task.id)));
		} else if (task.status === TaskStatus.Paused) {
			actions.appendChild(this._actionButton('Resume', () => this.taskQueue.resumeTask(task.id)));
			actions.appendChild(this._actionButton('Cancel', () => this.taskQueue.cancelTask(task.id)));
		} else if (task.status === TaskStatus.Queued) {
			actions.appendChild(this._actionButton('Cancel', () => this.taskQueue.cancelTask(task.id)));
		} else if (task.status === TaskStatus.Completed || task.status === TaskStatus.Failed || task.status === TaskStatus.Cancelled) {
			actions.appendChild(this._actionButton('Remove', () => this.taskQueue.removeTask(task.id)));
		}

		row.appendChild(actions);
		return row;
	}

	private _actionButton(label: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.className = 'nyrve-task-action-btn';
		btn.textContent = label;
		btn.addEventListener('click', onClick);
		return btn;
	}

	private _statusLabel(status: TaskStatus): string {
		switch (status) {
			case TaskStatus.Queued: return 'Queued';
			case TaskStatus.InProgress: return 'Running';
			case TaskStatus.AwaitingReview: return 'Review';
			case TaskStatus.Revision: return 'Revising';
			case TaskStatus.Completed: return 'Done';
			case TaskStatus.Failed: return 'Failed';
			case TaskStatus.Cancelled: return 'Cancelled';
			case TaskStatus.Paused: return 'Paused';
		}
	}
}
