/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';

// --- Types ---

export const enum UpdateState {
	Idle = 'idle',
	CheckingForUpdates = 'checking',
	UpdateAvailable = 'available',
	Downloading = 'downloading',
	Ready = 'ready',
	Error = 'error',
}

export interface UpdateInfo {
	readonly version: string;
	readonly releaseNotes: string;
	readonly downloadUrl: string;
	readonly publishedAt: string;
}

// --- Service Interface ---

export const INyrveUpdater = createDecorator<INyrveUpdater>('nyrveUpdater');

export interface INyrveUpdater {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<UpdateState>;
	readonly onDidFindUpdate: Event<UpdateInfo>;

	readonly state: UpdateState;
	readonly latestUpdate: UpdateInfo | undefined;

	/** Check for available updates. */
	checkForUpdates(): Promise<UpdateInfo | undefined>;

	/** Download the latest update. */
	downloadUpdate(): Promise<void>;

	/** Apply the downloaded update and restart. */
	applyUpdate(): Promise<void>;
}

// --- Service Implementation ---

export class NyrveUpdater extends Disposable implements INyrveUpdater {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<UpdateState>());
	readonly onDidChangeState: Event<UpdateState> = this._onDidChangeState.event;

	private readonly _onDidFindUpdate = this._register(new Emitter<UpdateInfo>());
	readonly onDidFindUpdate: Event<UpdateInfo> = this._onDidFindUpdate.event;

	private _state: UpdateState = UpdateState.Idle;
	private _latestUpdate: UpdateInfo | undefined;

	get state(): UpdateState {
		return this._state;
	}

	get latestUpdate(): UpdateInfo | undefined {
		return this._latestUpdate;
	}

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async checkForUpdates(): Promise<UpdateInfo | undefined> {
		if (this._state === UpdateState.CheckingForUpdates || this._state === UpdateState.Downloading) {
			return this._latestUpdate;
		}

		this._setState(UpdateState.CheckingForUpdates);

		try {
			// TODO: Replace with actual update endpoint when distribution is set up.
			// For now, this is a stub that always reports no updates.
			// The real implementation will:
			// 1. Fetch https://update.nyrve.dev/api/latest?platform=<platform>&arch=<arch>
			// 2. Compare version against current
			// 3. Return UpdateInfo if a newer version exists
			this.logService.info('[Nyrve] Checking for updates...');

			this._setState(UpdateState.Idle);
			return undefined;
		} catch (e) {
			this.logService.warn(`[Nyrve] Update check failed: ${e}`);
			this._setState(UpdateState.Error);
			return undefined;
		}
	}

	async downloadUpdate(): Promise<void> {
		if (!this._latestUpdate) {
			return;
		}

		this._setState(UpdateState.Downloading);

		try {
			// TODO: Download delta update package
			// The real implementation will:
			// 1. Download the update package from _latestUpdate.downloadUrl
			// 2. Verify checksum
			// 3. Stage for installation
			this.logService.info(`[Nyrve] Downloading update ${this._latestUpdate.version}...`);

			this._setState(UpdateState.Ready);
		} catch (e) {
			this.logService.warn(`[Nyrve] Update download failed: ${e}`);
			this._setState(UpdateState.Error);
		}
	}

	async applyUpdate(): Promise<void> {
		if (this._state !== UpdateState.Ready) {
			return;
		}

		// TODO: Apply the staged update and trigger app restart.
		// The real implementation will:
		// 1. Replace the current app binaries with the downloaded update
		// 2. Trigger Electron's autoUpdater.quitAndInstall() or equivalent
		this.logService.info('[Nyrve] Applying update and restarting...');
	}

	private _setState(state: UpdateState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}
}

registerSingleton(INyrveUpdater, NyrveUpdater, InstantiationType.Delayed);
