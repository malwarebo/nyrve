/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../vs/base/common/lifecycle.js';
import { localize } from '../../../vs/nls.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../vs/workbench/services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution } from '../../../vs/workbench/common/contributions.js';
import { ForgeAgentState, IForgeAgentService } from '../../agent/agent-service.js';
import { IForgeTokenTracker } from '../../agent/token-tracker.js';
import { IForgeAuthService, ConnectionStatus } from '../../core/auth-service.js';
import { FORGE_AGENT_VIEW_CONTAINER_ID } from '../agent-panel/agent-panel.js';

/**
 * Status bar contribution showing Forge connection status, agent state, model, and token usage.
 *
 * States:
 * - 🟢 Forge: Connected — key valid, API reachable
 * - 🟡 Forge: No API Key — click opens setup
 * - 🔴 Forge: Disconnected — key invalid or API unreachable
 * - ⏳ Forge: Connecting... — during validation
 *
 * When connected, shows the active model and agent state (idle/thinking/streaming).
 */
export class ForgeStatusBarContribution extends Disposable implements IWorkbenchContribution {

	private readonly statusAccessor = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IForgeAgentService private readonly agentService: IForgeAgentService,
		@IForgeTokenTracker private readonly tokenTracker: IForgeTokenTracker,
		@IForgeAuthService private readonly authService: IForgeAuthService,
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
		let command: string = FORGE_AGENT_VIEW_CONTAINER_ID;

		// Connection status takes priority when not connected
		if (connectionStatus !== 'connected') {
			const result = this._getConnectionDisplay(connectionStatus);
			text = result.text;
			tooltip = result.tooltip;
			command = 'forge.setupApiKey';
		} else {
			// Connected — show agent state
			switch (agentState) {
				case ForgeAgentState.Idle:
					text = `$(circle-filled) Forge: ${model}`;
					tooltip = localize(
						'forge.status.connected.idle',
						"Forge: Connected \u00b7 {0}\nTokens today: {1} (${2})",
						model,
						totalTokens.toLocaleString(),
						summary.totalCostUsd.toFixed(2)
					);
					break;
				case ForgeAgentState.Thinking:
					text = `$(loading~spin) Forge: Thinking...`;
					tooltip = localize('forge.status.thinking', "Forge Agent \u2014 Thinking...");
					break;
				case ForgeAgentState.Streaming:
					text = `$(loading~spin) Forge: Streaming...`;
					tooltip = localize('forge.status.streaming', "Forge Agent \u2014 Streaming response...");
					break;
				case ForgeAgentState.Error:
					text = `$(error) Forge: Error`;
					tooltip = localize('forge.status.error', "Forge Agent \u2014 An error occurred");
					break;
				default:
					text = `$(circle-filled) Forge: ${model}`;
					tooltip = localize('forge.status.default', "Forge Agent");
					break;
			}
		}

		const entry: IStatusbarEntry = {
			name: localize('forge.status.name', "Forge"),
			text,
			ariaLabel: text.replace(/\$\([^)]+\)\s*/g, ''),
			tooltip,
			command,
		};

		if (!this.statusAccessor.value) {
			this.statusAccessor.value = this.statusbarService.addEntry(entry, 'forge.status', StatusbarAlignment.LEFT, 100);
		} else {
			this.statusAccessor.value.update(entry);
		}
	}

	private _getConnectionDisplay(status: ConnectionStatus): { text: string; tooltip: string } {
		switch (status) {
			case 'no-key':
				return {
					text: '$(warning) Forge: No API Key',
					tooltip: localize('forge.status.noKey', "Forge: No API key configured. Click to set up."),
				};
			case 'disconnected':
				return {
					text: '$(error) Forge: Disconnected',
					tooltip: localize('forge.status.disconnected', "Forge: Cannot reach Anthropic API. Check your key or network."),
				};
			case 'connecting':
				return {
					text: '$(loading~spin) Forge: Connecting...',
					tooltip: localize('forge.status.connecting', "Forge: Validating API key..."),
				};
			default:
				return {
					text: '$(circle-filled) Forge: Connected',
					tooltip: localize('forge.status.connected', "Forge: Connected to Anthropic API"),
				};
		}
	}
}
