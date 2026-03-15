/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../vs/base/common/event.js';
import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';

// --- Types ---

export const enum TaskStatus {
	Queued = 'QUEUED',
	InProgress = 'IN_PROGRESS',
	AwaitingReview = 'AWAITING_REVIEW',
	Revision = 'REVISION',
	Completed = 'COMPLETED',
	Failed = 'FAILED',
	Cancelled = 'CANCELLED',
	Paused = 'PAUSED',
}

export const enum TaskPriority {
	Low = 'low',
	Medium = 'medium',
	High = 'high',
	Urgent = 'urgent',
}

export interface Task {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	status: TaskStatus;
	readonly priority: TaskPriority;
	readonly createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	estimatedTokens: number;
	actualTokens: number;
	readonly linkedIssue: string | null;
	readonly tags: readonly string[];
	error?: string;
}

export interface TaskCreateParams {
	readonly title: string;
	readonly description: string;
	readonly priority?: TaskPriority;
	readonly linkedIssue?: string;
	readonly tags?: readonly string[];
}

// --- Service Interface ---

export const IForgeTaskQueue = createDecorator<IForgeTaskQueue>('forgeTaskQueue');

export interface IForgeTaskQueue {
	readonly _serviceBrand: undefined;

	readonly onDidAddTask: Event<Task>;
	readonly onDidUpdateTask: Event<Task>;
	readonly onDidRemoveTask: Event<string>;

	/** Enqueue a new task. */
	addTask(params: TaskCreateParams): Task;

	/** Get all tasks. */
	getTasks(): readonly Task[];

	/** Get a single task by ID. */
	getTask(id: string): Task | undefined;

	/** Cancel a queued or running task. */
	cancelTask(id: string): void;

	/** Pause a running task. */
	pauseTask(id: string): void;

	/** Resume a paused task. */
	resumeTask(id: string): void;

	/** Remove a completed/cancelled/failed task from the queue. */
	removeTask(id: string): void;

	/** Reorder a task to a new position. */
	reorderTask(id: string, newIndex: number): void;

	/** Get the currently running task. */
	getActiveTask(): Task | undefined;

	/** Process the next queued task. */
	processNext(): void;

	/** Mark a task as completed. */
	completeTask(id: string): void;

	/** Mark a task as failed. */
	failTask(id: string, error: string): void;
}

// --- Service Implementation ---

let _taskIdCounter = 0;

export class ForgeTaskQueue extends Disposable implements IForgeTaskQueue {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAddTask = this._register(new Emitter<Task>());
	readonly onDidAddTask: Event<Task> = this._onDidAddTask.event;

	private readonly _onDidUpdateTask = this._register(new Emitter<Task>());
	readonly onDidUpdateTask: Event<Task> = this._onDidUpdateTask.event;

	private readonly _onDidRemoveTask = this._register(new Emitter<string>());
	readonly onDidRemoveTask: Event<string> = this._onDidRemoveTask.event;

	private readonly _tasks: Task[] = [];

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	addTask(params: TaskCreateParams): Task {
		const task: Task = {
			id: `task_${++_taskIdCounter}_${Date.now()}`,
			title: params.title,
			description: params.description,
			status: TaskStatus.Queued,
			priority: params.priority ?? TaskPriority.Medium,
			createdAt: new Date().toISOString(),
			startedAt: null,
			completedAt: null,
			estimatedTokens: 0,
			actualTokens: 0,
			linkedIssue: params.linkedIssue ?? null,
			tags: params.tags ?? [],
		};

		// Insert by priority
		const insertIndex = this._findInsertIndex(task.priority);
		this._tasks.splice(insertIndex, 0, task);

		this._onDidAddTask.fire(task);
		this.logService.info(`[Forge] Task queued: ${task.title} (${task.id})`);

		return task;
	}

	getTasks(): readonly Task[] {
		return this._tasks;
	}

	getTask(id: string): Task | undefined {
		return this._tasks.find(t => t.id === id);
	}

	cancelTask(id: string): void {
		const task = this.getTask(id);
		if (!task || task.status === TaskStatus.Completed || task.status === TaskStatus.Cancelled) {
			return;
		}

		task.status = TaskStatus.Cancelled;
		task.completedAt = new Date().toISOString();
		this._onDidUpdateTask.fire(task);
		this.logService.info(`[Forge] Task cancelled: ${task.title}`);
	}

	pauseTask(id: string): void {
		const task = this.getTask(id);
		if (!task || task.status !== TaskStatus.InProgress) {
			return;
		}

		task.status = TaskStatus.Paused;
		this._onDidUpdateTask.fire(task);
		this.logService.info(`[Forge] Task paused: ${task.title}`);
	}

	resumeTask(id: string): void {
		const task = this.getTask(id);
		if (!task || task.status !== TaskStatus.Paused) {
			return;
		}

		task.status = TaskStatus.Queued;
		this._onDidUpdateTask.fire(task);
		this.logService.info(`[Forge] Task resumed: ${task.title}`);
	}

	removeTask(id: string): void {
		const index = this._tasks.findIndex(t => t.id === id);
		if (index === -1) {
			return;
		}

		const task = this._tasks[index];
		if (task.status === TaskStatus.InProgress) {
			return; // Cannot remove a running task
		}

		this._tasks.splice(index, 1);
		this._onDidRemoveTask.fire(id);
	}

	reorderTask(id: string, newIndex: number): void {
		const currentIndex = this._tasks.findIndex(t => t.id === id);
		if (currentIndex === -1 || currentIndex === newIndex) {
			return;
		}

		const [task] = this._tasks.splice(currentIndex, 1);
		this._tasks.splice(Math.min(newIndex, this._tasks.length), 0, task);
		this._onDidUpdateTask.fire(task);
	}

	getActiveTask(): Task | undefined {
		return this._tasks.find(t => t.status === TaskStatus.InProgress);
	}

	processNext(): void {
		const maxConcurrent = this.configurationService.getValue<number>('forge.tasks.maxConcurrent') ?? 1;
		const runningCount = this._tasks.filter(t => t.status === TaskStatus.InProgress).length;

		if (runningCount >= maxConcurrent) {
			return;
		}

		const next = this._tasks.find(t => t.status === TaskStatus.Queued);
		if (!next) {
			return;
		}

		next.status = TaskStatus.InProgress;
		next.startedAt = new Date().toISOString();
		this._onDidUpdateTask.fire(next);
		this.logService.info(`[Forge] Task started: ${next.title}`);
	}

	completeTask(id: string): void {
		const task = this.getTask(id);
		if (!task || task.status !== TaskStatus.InProgress) {
			return;
		}

		task.status = TaskStatus.Completed;
		task.completedAt = new Date().toISOString();
		this._onDidUpdateTask.fire(task);
		this.logService.info(`[Forge] Task completed: ${task.title}`);
	}

	failTask(id: string, error: string): void {
		const task = this.getTask(id);
		if (!task) {
			return;
		}

		task.status = TaskStatus.Failed;
		task.completedAt = new Date().toISOString();
		task.error = error;
		this._onDidUpdateTask.fire(task);
		this.logService.warn(`[Forge] Task failed: ${task.title} — ${error}`);
	}

	private _findInsertIndex(priority: TaskPriority): number {
		const priorityOrder: Record<TaskPriority, number> = {
			[TaskPriority.Urgent]: 0,
			[TaskPriority.High]: 1,
			[TaskPriority.Medium]: 2,
			[TaskPriority.Low]: 3,
		};

		const targetOrder = priorityOrder[priority];

		// Find the first task with lower priority (higher order number)
		for (let i = 0; i < this._tasks.length; i++) {
			const task = this._tasks[i];
			if (task.status === TaskStatus.InProgress) {
				continue; // Skip running tasks at the front
			}
			if (priorityOrder[task.priority] > targetOrder) {
				return i;
			}
		}

		return this._tasks.length;
	}
}

registerSingleton(IForgeTaskQueue, ForgeTaskQueue, InstantiationType.Delayed);
