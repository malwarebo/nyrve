/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { Emitter } from '../../../vs/base/common/event.js';
import { localize2 } from '../../../vs/nls.js';
import { Action2, registerAction2 } from '../../../vs/platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../vs/platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { INyrveSettingsService } from '../../core/settings-service.js';
import { INyrveAuthService, ConnectionStatus } from '../../core/auth-service.js';
import { INyrveTokenTracker, TokenUsageSummary } from '../../agent/token-tracker.js';

// --- Types ---

export type SettingsSection = 'account' | 'models' | 'agent' | 'features' | 'privacy' | 'keybinds' | 'advanced';

export interface SettingsPageState {
	readonly activeSection: SettingsSection;
	readonly searchQuery: string;
	readonly connectionStatus: ConnectionStatus;
	readonly todayUsage: TokenUsageSummary;
	readonly hasApiKey: boolean;
}

// --- Message Protocol (webview ↔ host) ---

export interface SettingsMessage {
	readonly type: string;
	readonly [key: string]: unknown;
}

// --- Settings Page Controller ---

/**
 * Controls the Nyrve Settings Page data flow.
 * Manages state, handles messages from the webview, and pushes updates.
 */
export class NyrveSettingsPageController extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private readonly _onDidChangeState = this._register(new Emitter<SettingsPageState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _activeSection: SettingsSection = 'account';
	private _searchQuery = '';

	constructor(
		private readonly settingsService: INyrveSettingsService,
		private readonly authService: INyrveAuthService,
		private readonly tokenTracker: INyrveTokenTracker,
		private readonly logService: ILogService,
	) {
		super();

		this._disposables.add(this.settingsService.onSettingChanged(() => this._fireStateUpdate()));
		this._disposables.add(this.authService.onConnectionStatusChanged(() => this._fireStateUpdate()));
		this._disposables.add(this.tokenTracker.onDidRecordUsage(() => this._fireStateUpdate()));
	}

	getState(): SettingsPageState {
		return {
			activeSection: this._activeSection,
			searchQuery: this._searchQuery,
			connectionStatus: this.authService.getConnectionStatus(),
			todayUsage: this.tokenTracker.getTodaySummary(),
			hasApiKey: this.authService.getConnectionStatus() !== 'no-key',
		};
	}

	setActiveSection(section: SettingsSection): void {
		this._activeSection = section;
		this._fireStateUpdate();
	}

	setSearchQuery(query: string): void {
		this._searchQuery = query;
		this._fireStateUpdate();
	}

	async handleMessage(msg: SettingsMessage): Promise<void> {
		switch (msg.type) {
			case 'navigate':
				this.setActiveSection(msg.section as SettingsSection);
				break;
			case 'search':
				this.setSearchQuery(msg.query as string);
				break;
			case 'updateSetting':
				await this.settingsService.update(msg.key as string, msg.value);
				break;
			case 'testConnection':
				await this.authService.checkConnection();
				break;
			case 'changeApiKey': {
				const key = msg.key as string;
				if (key) {
					await this.authService.storeApiKey(key);
				}
				break;
			}
			case 'deleteApiKey':
				await this.authService.deleteApiKey();
				break;
			case 'refreshModels':
				await this.authService.refreshModels();
				break;
			default:
				this.logService.trace(`[Nyrve] Settings: unknown message type: ${msg.type}`);
		}
	}

	private _fireStateUpdate(): void {
		this._onDidChangeState.fire(this.getState());
	}
}

// --- Settings Page HTML ---

/**
 * Returns the full HTML content for the settings page webview.
 */
export function createSettingsPageContent(nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			display: flex;
			height: 100vh;
		}
		/* Sidebar */
		.settings-nav {
			width: 200px;
			min-width: 200px;
			background: var(--vscode-sideBar-background);
			border-right: 1px solid var(--vscode-panel-border);
			padding: 16px 0;
			display: flex;
			flex-direction: column;
		}
		.settings-nav-title {
			font-size: 14px;
			font-weight: 600;
			padding: 0 16px 16px;
		}
		.settings-nav-item {
			padding: 8px 16px;
			font-size: 13px;
			cursor: pointer;
			border-left: 3px solid transparent;
		}
		.settings-nav-item:hover { background: var(--vscode-list-hoverBackground); }
		.settings-nav-item.active {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
			border-left-color: var(--vscode-focusBorder);
		}
		/* Content */
		.settings-content {
			flex: 1;
			overflow-y: auto;
			padding: 24px 32px;
		}
		/* Search */
		.settings-search {
			width: 100%;
			padding: 8px 12px;
			font-size: 13px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			margin-bottom: 24px;
		}
		.settings-search:focus { outline: none; border-color: var(--vscode-focusBorder); }
		/* Sections */
		.settings-section { display: none; }
		.settings-section.active { display: block; }
		.settings-section h2 { font-size: 20px; margin-bottom: 16px; }
		.settings-section h3 { font-size: 14px; margin: 16px 0 8px; opacity: 0.8; }
		/* Setting items */
		.setting-item {
			padding: 12px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.setting-label { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
		.setting-desc { font-size: 12px; opacity: 0.7; margin-bottom: 8px; }
		.setting-control select, .setting-control input[type="number"] {
			padding: 4px 8px;
			font-size: 13px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
		}
		.setting-control input[type="checkbox"] { margin-right: 8px; }
		.setting-control textarea {
			width: 100%;
			min-height: 80px;
			padding: 8px;
			font-size: 13px;
			font-family: var(--vscode-editor-font-family, monospace);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			resize: vertical;
		}
		.btn {
			padding: 6px 12px;
			font-size: 12px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			margin-right: 8px;
		}
		.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.btn-danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
		.connection-badge {
			display: inline-block;
			padding: 2px 8px;
			border-radius: 10px;
			font-size: 12px;
			margin-bottom: 12px;
		}
		.connection-connected { background: #2e7d3266; color: #4caf50; }
		.connection-disconnected { background: #c6282866; color: #ef5350; }
		.connection-no-key { background: #f9a82566; color: #ffc107; }
		.usage-stat { font-size: 13px; margin: 4px 0; }
		.usage-stat strong { font-weight: 600; }
		.keybind-table { width: 100%; border-collapse: collapse; }
		.keybind-table th, .keybind-table td {
			text-align: left;
			padding: 8px;
			border-bottom: 1px solid var(--vscode-panel-border);
			font-size: 13px;
		}
		.keybind-table th { opacity: 0.7; font-weight: 600; }
		kbd {
			padding: 2px 6px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 3px;
			font-size: 12px;
			font-family: var(--vscode-editor-font-family, monospace);
		}
	</style>
</head>
<body>
	<div class="settings-nav">
		<div class="settings-nav-title"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="20" height="20" style="vertical-align:middle;margin-right:6px;"><defs><linearGradient id="of" x1="0.3" y1="1" x2="0.7" y2="0"><stop offset="0%" stop-color="#993C1D"/><stop offset="40%" stop-color="#D85A30"/><stop offset="70%" stop-color="#EF9F27"/><stop offset="100%" stop-color="#FAC775"/></linearGradient><linearGradient id="if" x1="0.5" y1="1" x2="0.5" y2="0"><stop offset="0%" stop-color="#EF9F27"/><stop offset="60%" stop-color="#FAC775"/><stop offset="100%" stop-color="#FAEEDA"/></linearGradient></defs><path d="M256 56C362 140,432 244,432 320C432 416,352 480,256 480C160 480,80 416,80 320C80 244,150 140,256 56Z" fill="url(#of)"/><path d="M256 186C309 250,346 300,346 344C346 394,306 420,256 420C206 420,166 394,166 344C166 300,203 250,256 186Z" fill="url(#if)" opacity="0.85"/><ellipse cx="256" cy="356" rx="42" ry="46" fill="#FAEEDA" opacity="0.4"/></svg>Nyrve Settings</div>
		<div class="settings-nav-item active" data-section="account">Account</div>
		<div class="settings-nav-item" data-section="models">Models</div>
		<div class="settings-nav-item" data-section="agent">Agent</div>
		<div class="settings-nav-item" data-section="features">Features</div>
		<div class="settings-nav-item" data-section="privacy">Privacy</div>
		<div class="settings-nav-item" data-section="keybinds">Keybinds</div>
		<div class="settings-nav-item" data-section="advanced">Advanced</div>
	</div>
	<div class="settings-content">
		<input type="text" class="settings-search" id="searchInput" placeholder="Search settings..." />

		<!-- Account -->
		<div class="settings-section active" id="section-account">
			<h2>Account</h2>
			<div id="connectionBadge" class="connection-badge connection-no-key">No API Key</div>
			<div class="setting-item">
				<div class="setting-label">Anthropic API Key</div>
				<div class="setting-desc">Your key is stored in the OS keychain. It never leaves your machine.</div>
				<div class="setting-control">
					<input type="password" id="apiKeyDisplay" style="width:300px;padding:4px 8px;font-family:monospace;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;" placeholder="sk-ant-..." readonly />
					<button class="btn btn-secondary" id="changeKeyBtn">Change Key</button>
					<button class="btn btn-secondary" id="testConnBtn">Test Connection</button>
					<button class="btn btn-danger" id="disconnectBtn">Disconnect</button>
				</div>
			</div>
			<h3>Usage Today</h3>
			<div id="usageStats">
				<p class="usage-stat">Tokens: <strong id="usageTokens">0</strong></p>
				<p class="usage-stat">Cost: <strong id="usageCost">$0.00</strong></p>
			</div>
		</div>

		<!-- Models -->
		<div class="settings-section" id="section-models">
			<h2>Models</h2>
			<div class="setting-item">
				<div class="setting-label">Default Model</div>
				<div class="setting-desc">Used for interactive agent chat.</div>
				<div class="setting-control">
					<select id="defaultModel" data-key="nyrve.agent.defaultModel">
						<option value="claude-opus">Claude Opus</option>
						<option value="claude-sonnet" selected>Claude Sonnet</option>
						<option value="claude-haiku">Claude Haiku</option>
					</select>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Complex Task Model</div>
				<div class="setting-desc">Used for multi-file tasks and planning.</div>
				<div class="setting-control">
					<select id="complexModel" data-key="nyrve.agent.complexTaskModel">
						<option value="claude-opus" selected>Claude Opus</option>
						<option value="claude-sonnet">Claude Sonnet</option>
						<option value="claude-haiku">Claude Haiku</option>
					</select>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Background Model</div>
				<div class="setting-desc">Used for background agent suggestions.</div>
				<div class="setting-control">
					<select id="bgModel" data-key="nyrve.agent.backgroundModel">
						<option value="claude-opus">Claude Opus</option>
						<option value="claude-sonnet">Claude Sonnet</option>
						<option value="claude-haiku" selected>Claude Haiku</option>
					</select>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Show Model Selector in Agent Panel</div>
				<div class="setting-control">
					<label><input type="checkbox" id="modelSwitcher" data-key="nyrve.agent.modelSwitcher" checked /> Enabled</label>
				</div>
			</div>
		</div>

		<!-- Agent -->
		<div class="settings-section" id="section-agent">
			<h2>Agent</h2>
			<div class="setting-item">
				<div class="setting-label">Confirmation Level</div>
				<div class="setting-desc">Controls how much confirmation the agent requires.</div>
				<div class="setting-control">
					<select id="confirmLevel" data-key="nyrve.agent.confirmationLevel">
						<option value="cautious">Cautious \u2014 confirm every action</option>
						<option value="balanced" selected>Balanced \u2014 confirm writes and commands</option>
						<option value="autonomous">Autonomous \u2014 no confirmation</option>
					</select>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Max Tokens per Request</div>
				<div class="setting-control">
					<input type="number" id="maxTokens" data-key="nyrve.agent.maxTokensPerRequest" value="100000" min="1000" max="200000" step="1000" />
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Stream Responses</div>
				<div class="setting-control">
					<label><input type="checkbox" id="streamResp" data-key="nyrve.agent.streamResponses" checked /> Stream token by token</label>
				</div>
			</div>
		</div>

		<!-- Features -->
		<div class="settings-section" id="section-features">
			<h2>Features</h2>
			<div class="setting-item">
				<div class="setting-label">Background Agent</div>
				<div class="setting-control">
					<label><input type="checkbox" data-key="nyrve.backgroundAgent.enabled" checked /> Enabled</label>
				</div>
				<div class="setting-desc" style="margin-top:8px">Mode:</div>
				<div class="setting-control">
					<select data-key="nyrve.backgroundAgent.mode">
						<option value="active">Active \u2014 real-time</option>
						<option value="on-save" selected>On Save</option>
						<option value="on-commit">On Commit</option>
						<option value="off">Off</option>
					</select>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Codebase Indexing</div>
				<div class="setting-control">
					<label><input type="checkbox" data-key="nyrve.indexer.enabled" checked /> Enabled</label>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Session Memory</div>
				<div class="setting-control">
					<label><input type="checkbox" data-key="nyrve.memory.enabled" checked /> Enabled</label>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">GitHub Integration</div>
				<div class="setting-control">
					<label><input type="checkbox" data-key="nyrve.github.enabled" checked /> Enabled</label>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Diff Review</div>
				<div class="setting-control">
					<label><input type="checkbox" data-key="nyrve.diff.autoOpenOnChange" checked /> Auto-open on agent changes</label>
				</div>
				<div class="setting-control" style="margin-top:4px">
					<label><input type="checkbox" data-key="nyrve.diff.showGutterDecorations" checked /> Show gutter decorations</label>
				</div>
			</div>
		</div>

		<!-- Privacy -->
		<div class="settings-section" id="section-privacy">
			<h2>Privacy</h2>
			<p style="font-size:13px;opacity:0.8;margin-bottom:16px;">All Nyrve data is stored locally on your machine. Your API key is in the OS keychain. Code is sent directly to Anthropic \u2014 there is no Nyrve backend.</p>
			<div class="setting-item">
				<div class="setting-label">Anonymous Usage Analytics</div>
				<div class="setting-desc">Help improve Nyrve with anonymous feature usage data. No code or file contents are ever collected.</div>
				<div class="setting-control">
					<label><input type="checkbox" data-key="nyrve.telemetry.enabled" /> Opt in</label>
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Cloud Memory Sync</div>
				<div class="setting-desc">Sync project memory across machines via encrypted cloud backup.</div>
				<div class="setting-control">
					<label><input type="checkbox" data-key="nyrve.memory.cloudSync" /> Opt in</label>
				</div>
			</div>
		</div>

		<!-- Keybinds -->
		<div class="settings-section" id="section-keybinds">
			<h2>Keyboard Shortcuts</h2>
			<table class="keybind-table">
				<thead><tr><th>Action</th><th>Shortcut</th></tr></thead>
				<tbody>
					<tr><td>Toggle Agent Panel</td><td><kbd>Cmd+Shift+A</kbd></td></tr>
					<tr><td>Accept Current Hunk</td><td><kbd>Cmd+Shift+Y</kbd></td></tr>
					<tr><td>Reject Current Hunk</td><td><kbd>Cmd+Shift+N</kbd></td></tr>
					<tr><td>Accept All Changes</td><td><kbd>Cmd+Shift+Enter</kbd></td></tr>
				</tbody>
			</table>
		</div>

		<!-- Advanced -->
		<div class="settings-section" id="section-advanced">
			<h2>Advanced</h2>
			<div class="setting-item">
				<div class="setting-label">Context Token Budget</div>
				<div class="setting-desc">Default token budget for agent context assembly.</div>
				<div class="setting-control">
					<input type="number" data-key="nyrve.context.defaultTokenBudget" value="30000" min="1000" max="100000" step="1000" />
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Background Agent Daily Budget</div>
				<div class="setting-desc">Maximum tokens per day for background analysis.</div>
				<div class="setting-control">
					<input type="number" data-key="nyrve.backgroundAgent.dailyTokenBudget" value="500000" min="0" step="10000" />
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Task Queue Daily Budget</div>
				<div class="setting-desc">Maximum tokens per day for queued task execution.</div>
				<div class="setting-control">
					<input type="number" data-key="nyrve.tasks.dailyTokenBudget" value="1000000" min="0" step="10000" />
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Memory Max Entries</div>
				<div class="setting-control">
					<input type="number" data-key="nyrve.memory.maxEntries" value="1000" min="100" step="100" />
				</div>
			</div>
			<div class="setting-item">
				<div class="setting-label">Memory Decay Days</div>
				<div class="setting-desc">Days before unused memory confidence decays.</div>
				<div class="setting-control">
					<input type="number" data-key="nyrve.memory.decayDays" value="90" min="7" step="1" />
				</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		// Navigation
		document.querySelectorAll('.settings-nav-item').forEach(item => {
			item.addEventListener('click', () => {
				const section = item.dataset.section;
				document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
				item.classList.add('active');
				document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
				document.getElementById('section-' + section).classList.add('active');
				vscode.postMessage({ type: 'navigate', section });
			});
		});

		// Search
		document.getElementById('searchInput').addEventListener('input', e => {
			const q = e.target.value.toLowerCase();
			document.querySelectorAll('.setting-item').forEach(item => {
				const text = item.textContent.toLowerCase();
				item.style.display = q && !text.includes(q) ? 'none' : '';
			});
			vscode.postMessage({ type: 'search', query: q });
		});

		// Setting controls (auto-save on change)
		document.querySelectorAll('[data-key]').forEach(el => {
			const key = el.dataset.key;
			const handler = () => {
				let value;
				if (el.type === 'checkbox') value = el.checked;
				else if (el.type === 'number') value = parseInt(el.value, 10);
				else value = el.value;
				vscode.postMessage({ type: 'updateSetting', key, value });
			};
			el.addEventListener('change', handler);
			if (el.type === 'number') el.addEventListener('input', handler);
		});

		// Account actions
		document.getElementById('testConnBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'testConnection' });
		});
		document.getElementById('changeKeyBtn').addEventListener('click', () => {
			const key = prompt('Enter your Anthropic API key:');
			if (key) vscode.postMessage({ type: 'changeApiKey', key });
		});
		document.getElementById('disconnectBtn').addEventListener('click', () => {
			if (confirm('Remove your API key? AI features will be disabled.')) {
				vscode.postMessage({ type: 'deleteApiKey' });
			}
		});

		// Receive state updates from host
		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'stateUpdate') {
				// Update connection badge
				const badge = document.getElementById('connectionBadge');
				const statusMap = {
					'connected': ['Connected', 'connection-connected'],
					'disconnected': ['Disconnected', 'connection-disconnected'],
					'no-key': ['No API Key', 'connection-no-key'],
					'connecting': ['Connecting...', 'connection-no-key'],
				};
				const [label, cls] = statusMap[msg.connectionStatus] || ['Unknown', ''];
				badge.textContent = label;
				badge.className = 'connection-badge ' + cls;

				// Update usage
				if (msg.todayUsage) {
					document.getElementById('usageTokens').textContent =
						(msg.todayUsage.totalInputTokens + msg.todayUsage.totalOutputTokens).toLocaleString();
					document.getElementById('usageCost').textContent =
						'$' + msg.todayUsage.totalCostUsd.toFixed(2);
				}
			}
		});
	</script>
</body>
</html>`;
}

// --- Command Registration ---

const NYRVE_SETTINGS_CATEGORY = localize2('nyrve.settings.category', "Nyrve");

registerAction2(class OpenNyrveSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.openSettings',
			title: localize2('nyrve.openSettings', "Open Settings"),
			category: NYRVE_SETTINGS_CATEGORY,
		});
	}
	async run(_accessor: ServicesAccessor): Promise<void> {
		// TODO: Open the settings webview editor tab.
		// For now, this command is registered as a placeholder.
		// The webview editor provider will be wired when the full
		// webview panel infrastructure is connected.
	}
});
