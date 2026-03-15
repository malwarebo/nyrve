/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { localize2 } from '../../../vs/nls.js';
import { Action2, registerAction2 } from '../../../vs/platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../vs/platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IOpenerService } from '../../../vs/platform/opener/common/opener.js';
import { URI } from '../../../vs/base/common/uri.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../vs/workbench/common/contributions.js';
import { IForgeAuthService } from '../../core/auth-service.js';

// --- Welcome Page Content ---

function getWelcomePageHTML(nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">
		body {
			font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			display: flex;
			justify-content: center;
			align-items: center;
			min-height: 100vh;
			margin: 0;
			padding: 24px;
		}
		.welcome-container {
			max-width: 520px;
			width: 100%;
			text-align: center;
		}
		.welcome-logo {
			font-size: 48px;
			margin-bottom: 8px;
		}
		h1 {
			font-size: 28px;
			font-weight: 600;
			margin: 0 0 8px;
		}
		.subtitle {
			font-size: 14px;
			opacity: 0.7;
			margin-bottom: 32px;
		}
		.api-key-section {
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 8px;
			padding: 24px;
			margin-bottom: 24px;
			text-align: left;
		}
		.api-key-section h2 {
			font-size: 16px;
			margin: 0 0 4px;
		}
		.api-key-section p {
			font-size: 13px;
			opacity: 0.8;
			margin: 0 0 16px;
		}
		.api-key-input {
			width: 100%;
			padding: 8px 12px;
			font-size: 13px;
			font-family: var(--vscode-editor-font-family, monospace);
			background: var(--vscode-editor-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			box-sizing: border-box;
			margin-bottom: 12px;
		}
		.api-key-input:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}
		.btn-row {
			display: flex;
			gap: 8px;
		}
		.btn-primary {
			flex: 1;
			padding: 8px 16px;
			font-size: 13px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
		}
		.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
		.btn-primary:disabled { opacity: 0.5; cursor: default; }
		.btn-secondary {
			padding: 8px 16px;
			font-size: 13px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
		}
		.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.status-message {
			font-size: 13px;
			margin-top: 12px;
			padding: 8px;
			border-radius: 4px;
			display: none;
		}
		.status-success {
			display: block;
			background: var(--vscode-inputValidation-infoBackground);
			border: 1px solid var(--vscode-inputValidation-infoBorder);
		}
		.status-error {
			display: block;
			background: var(--vscode-inputValidation-errorBackground);
			border: 1px solid var(--vscode-inputValidation-errorBorder);
		}
		.status-validating {
			display: block;
			opacity: 0.7;
		}
		.security-note {
			font-size: 12px;
			opacity: 0.6;
			margin-top: 16px;
			line-height: 1.5;
		}
		.skip-link {
			font-size: 13px;
			opacity: 0.6;
			cursor: pointer;
			text-decoration: underline;
		}
		.skip-link:hover { opacity: 1; }
	</style>
</head>
<body>
	<div class="welcome-container">
		<div class="welcome-logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="72" height="72"><defs><linearGradient id="of" x1="0.3" y1="1" x2="0.7" y2="0"><stop offset="0%" stop-color="#993C1D"/><stop offset="40%" stop-color="#D85A30"/><stop offset="70%" stop-color="#EF9F27"/><stop offset="100%" stop-color="#FAC775"/></linearGradient><linearGradient id="if" x1="0.5" y1="1" x2="0.5" y2="0"><stop offset="0%" stop-color="#EF9F27"/><stop offset="60%" stop-color="#FAC775"/><stop offset="100%" stop-color="#FAEEDA"/></linearGradient></defs><path d="M256 56C362 140,432 244,432 320C432 416,352 480,256 480C160 480,80 416,80 320C80 244,150 140,256 56Z" fill="url(#of)"/><path d="M256 186C309 250,346 300,346 344C346 394,306 420,256 420C206 420,166 394,166 344C166 300,203 250,256 186Z" fill="url(#if)" opacity="0.85"/><ellipse cx="256" cy="356" rx="42" ry="46" fill="#FAEEDA" opacity="0.4"/></svg></div>
		<h1>Welcome to Forge</h1>
		<p class="subtitle">AI-native code editor powered by Claude</p>

		<div class="api-key-section">
			<h2>Enter Your Anthropic API Key</h2>
			<p>Forge uses your own Anthropic API key. All calls go directly from your machine to api.anthropic.com — no middleman.</p>
			<input type="password" class="api-key-input" id="apiKeyInput" placeholder="sk-ant-..." autocomplete="off" spellcheck="false" />
			<div class="btn-row">
				<button class="btn-primary" id="submitBtn" disabled>Validate &amp; Connect</button>
				<button class="btn-secondary" id="getKeyBtn">Get a Key</button>
			</div>
			<div class="status-message" id="statusMessage"></div>
		</div>

		<p class="security-note">
			Your API key is stored exclusively in your OS keychain (macOS Keychain, Windows Credential Manager, or Linux libsecret).
			It is never written to disk, logs, settings, or environment variables.
		</p>

		<p><span class="skip-link" id="skipBtn">Skip for now — use Forge as a normal editor</span></p>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const input = document.getElementById('apiKeyInput');
		const submitBtn = document.getElementById('submitBtn');
		const getKeyBtn = document.getElementById('getKeyBtn');
		const skipBtn = document.getElementById('skipBtn');
		const statusEl = document.getElementById('statusMessage');

		input.addEventListener('input', () => {
			submitBtn.disabled = input.value.trim().length < 10;
		});

		submitBtn.addEventListener('click', () => {
			const key = input.value.trim();
			if (!key) return;
			submitBtn.disabled = true;
			statusEl.className = 'status-message status-validating';
			statusEl.textContent = 'Validating...';
			vscode.postMessage({ type: 'validate', key });
		});

		getKeyBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'openConsole' });
		});

		skipBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'skip' });
		});

		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'validationResult') {
				if (msg.valid) {
					statusEl.className = 'status-message status-success';
					statusEl.textContent = 'Connected! Forge is ready.';
					setTimeout(() => vscode.postMessage({ type: 'close' }), 1500);
				} else {
					statusEl.className = 'status-message status-error';
					statusEl.textContent = msg.message || 'Validation failed.';
					submitBtn.disabled = false;
				}
			}
		});
	</script>
</body>
</html>`;
}

// --- Welcome Page Contribution ---

/**
 * Shows the Forge welcome page on first launch when no API key is configured.
 * Also registerable via command palette: "Forge: Setup API Key"
 */
export class ForgeWelcomeContribution extends Disposable {
	static readonly ID = 'forge.welcome';

	constructor(
		@IForgeAuthService private readonly authService: IForgeAuthService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._checkFirstLaunch();
	}

	private async _checkFirstLaunch(): Promise<void> {
		const hasKey = await this.authService.hasApiKey();
		if (!hasKey) {
			this.logService.info('[Forge] No API key configured — welcome page available via "Forge: Setup API Key" command');
		}
	}
}

/**
 * Returns the welcome page HTML content. Exported for use by webview panels.
 */
export function createWelcomePageContent(nonce: string): string {
	return getWelcomePageHTML(nonce);
}

// --- Commands ---

registerAction2(class SetupApiKeyAction extends Action2 {
	constructor() {
		super({
			id: 'forge.setupApiKey',
			title: localize2('forge.setupApiKey', "Setup API Key"),
			category: localize2('forge.category', "Forge"),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		// For now, open the Anthropic console as a fallback.
		// When the webview editor is fully wired, this will open the welcome tab.
		await openerService.open(URI.parse('https://console.anthropic.com/'));
	}
});

registerWorkbenchContribution2(
	ForgeWelcomeContribution.ID,
	ForgeWelcomeContribution,
	WorkbenchPhase.AfterRestored
);
