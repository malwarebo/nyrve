/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../vs/base/common/lifecycle.js';
import { localize } from '../../../vs/nls.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../vs/workbench/services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution } from '../../../vs/workbench/common/contributions.js';
import { NyrveAgentState, INyrveAgentService } from '../../agent/agent-service.js';
import { INyrveTokenTracker } from '../../agent/token-tracker.js';
import { INyrveAuthService, ConnectionStatus } from '../../core/auth-service.js';
import { NYRVE_AGENT_VIEW_CONTAINER_ID } from '../agent-panel/agent-panel.js';

/**
 * Status bar contribution showing Nyrve connection status, agent state, model, and token usage.
 *
 * States:
 * - Connected — key valid, API reachable
 * - No API Key — click opens setup
 * - Disconnected — key invalid or API unreachable
 * - Connecting... — during validation
 *
 * When connected, shows the active model and agent state (idle/thinking/streaming).
 */
export class NyrveStatusBarContribution extends Disposable implements IWorkbenchContribution {

	private readonly statusAccessor = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@INyrveAgentService private readonly agentService: INyrveAgentService,
		@INyrveTokenTracker private readonly tokenTracker: INyrveTokenTracker,
		@INyrveAuthService private readonly authService: INyrveAuthService,
	) {
		super();

		this._updateEntry();

		this._register(this.agentService.onDidChangeState(() => this._updateEntry()));
		this._register(this.tokenTracker.onDidRecordUsage(() => this._updateEntry()));
		this._register(this.authService.onConnectionStatusChanged(() => this._updateEntry()));
	}

	private _updateEntry(): void {
		const connectionStatus = this.authService.getConnectionStatus();
		const agentState = this.agentService.state;
		const model = this.agentService.getActiveModel();
		const summary = this.tokenTracker.getTodaySummary();
		const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;

		let text: string;
		let tooltip: string;
		let command: string = NYRVE_AGENT_VIEW_CONTAINER_ID;

		// Connection status takes priority when not connected
		if (connectionStatus !== 'connected') {
			const result = this._getConnectionDisplay(connectionStatus);
			text = result.text;
			tooltip = result.tooltip;
			command = 'nyrve.setupApiKey';
		} else {
			// Connected — show agent state
			switch (agentState) {
				case NyrveAgentState.Idle:
					text = `$(circle-filled) Nyrve: ${model}`;
					tooltip = localize(
						'nyrve.status.connected.idle',
						"Nyrve: Connected \u00b7 {0}\nTokens today: {1} (${2})",
						model,
						totalTokens.toLocaleString(),
						summary.totalCostUsd.toFixed(2)
					);
					break;
				case NyrveAgentState.Thinking:
					text = `$(loading~spin) Nyrve: Thinking...`;
					tooltip = localize('nyrve.status.thinking', "Nyrve Agent \u2014 Thinking...");
					break;
				case NyrveAgentState.Streaming:
					text = `$(loading~spin) Nyrve: Streaming...`;
					tooltip = localize('nyrve.status.streaming', "Nyrve Agent \u2014 Streaming response...");
					break;
				case NyrveAgentState.Error:
					text = `$(error) Nyrve: Error`;
					tooltip = localize('nyrve.status.error', "Nyrve Agent \u2014 An error occurred");
					break;
				default:
					text = `$(circle-filled) Nyrve: ${model}`;
					tooltip = localize('nyrve.status.default', "Nyrve Agent");
					break;
			}
		}

		const entry: IStatusbarEntry = {
			name: localize('nyrve.status.name', "Nyrve"),
			text,
			ariaLabel: text.replace(/\$\([^)]+\)\s*/g, ''),
			tooltip,
			command,
		};

		if (!this.statusAccessor.value) {
			this.statusAccessor.value = this.statusbarService.addEntry(entry, 'nyrve.status', StatusbarAlignment.LEFT, 100);
		} else {
			this.statusAccessor.value.update(entry);
		}
	}

	private _getConnectionDisplay(status: ConnectionStatus): { text: string; tooltip: string } {
		switch (status) {
			case 'no-key':
				return {
					text: '$(warning) Nyrve: No API Key',
					tooltip: localize('nyrve.status.noKey', "Nyrve: No API key configured. Click to set up."),
				};
			case 'disconnected':
				return {
					text: '$(error) Nyrve: Disconnected',
					tooltip: localize('nyrve.status.disconnected', "Nyrve: Cannot reach Anthropic API. Check your key or network."),
				};
			case 'connecting':
				return {
					text: '$(loading~spin) Nyrve: Connecting...',
					tooltip: localize('nyrve.status.connecting', "Nyrve: Validating API key..."),
				};
			default:
				return {
					text: '$(circle-filled) Nyrve: Connected',
					tooltip: localize('nyrve.status.connected', "Nyrve: Connected to Anthropic API"),
				};
		}
	}
}
