/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';

// --- Types ---

export interface TelemetryEvent {
	readonly name: string;
	readonly properties?: Record<string, string>;
	readonly measurements?: Record<string, number>;
	readonly timestamp: string;
}

// --- Service Interface ---

export const INyrveTelemetry = createDecorator<INyrveTelemetry>('nyrveTelemetry');

export interface INyrveTelemetry {
	readonly _serviceBrand: undefined;

	/** Whether telemetry collection is currently enabled. */
	readonly isEnabled: boolean;

	/** Log a telemetry event (only collected if user has opted in). */
	logEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;

	/** Flush any buffered events. */
	flush(): Promise<void>;
}

// --- Service Implementation ---

/**
 * Opt-in anonymous telemetry for Nyrve usage analytics.
 * Events are buffered locally and only transmitted if the user
 * has explicitly enabled `nyrve.telemetry.enabled`.
 *
 * No PII, file contents, or code is ever collected.
 * Only high-level feature usage counts and performance metrics.
 */
export class NyrveTelemetry extends Disposable implements INyrveTelemetry {
	declare readonly _serviceBrand: undefined;

	private readonly _buffer: TelemetryEvent[] = [];
	private static readonly MAX_BUFFER_SIZE = 100;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	get isEnabled(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.telemetry.enabled') ?? false;
	}

	logEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
		if (!this.isEnabled) {
			return;
		}

		const event: TelemetryEvent = {
			name,
			properties,
			measurements,
			timestamp: new Date().toISOString(),
		};

		this._buffer.push(event);
		this.logService.trace(`[Nyrve] Telemetry event: ${name}`);

		// Prevent unbounded buffer growth
		if (this._buffer.length > NyrveTelemetry.MAX_BUFFER_SIZE) {
			this._buffer.splice(0, this._buffer.length - NyrveTelemetry.MAX_BUFFER_SIZE);
		}
	}

	async flush(): Promise<void> {
		if (!this.isEnabled || this._buffer.length === 0) {
			return;
		}

		const events = this._buffer.splice(0);
		this.logService.trace(`[Nyrve] Flushing ${events.length} telemetry events`);

		// TODO: Transmit to telemetry endpoint when one is configured.
		// For now, events are simply discarded after flush.
		// The buffer collection still works so that when a telemetry
		// endpoint is added, we can start transmitting immediately.
		void events;
	}
}

registerSingleton(INyrveTelemetry, NyrveTelemetry, InstantiationType.Delayed);
