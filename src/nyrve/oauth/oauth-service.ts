/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OAuth 2.0 + PKCE service for authenticating with Anthropic's console.
 *
 * Flow:
 * 1. Generate PKCE verifier/challenge pair
 * 2. Open browser to Anthropic's authorization endpoint
 * 3. Receive callback on localhost with authorization code
 * 4. Exchange code for access token
 * 5. Use access token to create a permanent API key
 * 6. Return the API key for keychain storage
 */

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IOpenerService } from '../../vs/platform/opener/common/opener.js';
import { URI } from '../../vs/base/common/uri.js';
import { generatePkce, generateState } from './pkce.js';
import { NyrveOAuthCallbackServer } from './callback-server.js';

// --- Constants ---

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_AUTH_URL = 'https://console.anthropic.com/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_CREATE_KEY_URL = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';
const API_KEY_NAME = 'Nyrve IDE';

// --- Types ---

export interface OAuthSignInResult {
	readonly apiKey: string;
	readonly organizationId?: string;
}

interface TokenResponse {
	readonly access_token: string;
	readonly token_type: string;
	readonly expires_in?: number;
}

interface CreateApiKeyResponse {
	readonly api_key: string;
	readonly organization_id?: string;
}

// --- Service Interface ---

export const INyrveOAuthService = createDecorator<INyrveOAuthService>('nyrveOAuthService');

export interface INyrveOAuthService {
	readonly _serviceBrand: undefined;

	/**
	 * Start the full OAuth sign-in flow.
	 * Opens a browser, waits for callback, exchanges tokens, and returns an API key.
	 */
	signIn(): Promise<OAuthSignInResult>;

	/** Whether a sign-in flow is currently in progress. */
	readonly isSigningIn: boolean;

	/** Cancel any in-progress sign-in flow. */
	cancel(): void;
}

// --- Service Implementation ---

export class NyrveOAuthService extends Disposable implements INyrveOAuthService {
	declare readonly _serviceBrand: undefined;

	private _callbackServer: NyrveOAuthCallbackServer | undefined;
	private _isSigningIn = false;

	get isSigningIn(): boolean {
		return this._isSigningIn;
	}

	constructor(
		@IOpenerService private readonly openerService: IOpenerService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async signIn(): Promise<OAuthSignInResult> {
		if (this._isSigningIn) {
			throw new Error('OAuth sign-in already in progress');
		}

		this._isSigningIn = true;
		this._callbackServer = new NyrveOAuthCallbackServer();

		try {
			// 1. Generate PKCE pair and state
			const [pkce, state] = await Promise.all([generatePkce(), generateState()]);
			this.logService.info('[Nyrve OAuth] Starting sign-in flow');

			// 2. Start callback server
			await this._callbackServer.start();
			const redirectUri = this._callbackServer.redirectUri;
			this.logService.trace(`[Nyrve OAuth] Callback server listening at ${redirectUri}`);

			// 3. Build authorization URL
			const authUrl = this._buildAuthorizationUrl(pkce.challenge, state, redirectUri);

			// 4. Open browser
			await this.openerService.open(URI.parse(authUrl), { openExternal: true });
			this.logService.info('[Nyrve OAuth] Opened browser for authorization');

			// 5. Wait for callback
			const callback = await this._callbackServer.waitForCallback();

			// 6. Validate state parameter (CSRF protection)
			if (callback.state !== state) {
				throw new Error('OAuth state mismatch — possible CSRF attack');
			}

			this.logService.info('[Nyrve OAuth] Received authorization code');

			// 7. Exchange code for access token
			const tokenResponse = await this._exchangeCodeForToken(
				callback.code,
				pkce.verifier,
				redirectUri,
			);
			this.logService.info('[Nyrve OAuth] Obtained access token');

			// 8. Create permanent API key
			const keyResponse = await this._createApiKey(tokenResponse.access_token);
			this.logService.info('[Nyrve OAuth] Created permanent API key');

			return {
				apiKey: keyResponse.api_key,
				organizationId: keyResponse.organization_id,
			};
		} finally {
			await this._cleanup();
		}
	}

	cancel(): void {
		if (this._isSigningIn) {
			this.logService.info('[Nyrve OAuth] Sign-in cancelled by user');
			this._cleanup();
		}
	}

	private _buildAuthorizationUrl(codeChallenge: string, state: string, redirectUri: string): string {
		const params = new URLSearchParams({
			response_type: 'code',
			client_id: ANTHROPIC_CLIENT_ID,
			redirect_uri: redirectUri,
			scope: OAUTH_SCOPES,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
		});

		return `${ANTHROPIC_AUTH_URL}?${params.toString()}`;
	}

	private async _exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<TokenResponse> {
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: ANTHROPIC_CLIENT_ID,
			code,
			code_verifier: codeVerifier,
			redirect_uri: redirectUri,
		});

		const response = await fetch(ANTHROPIC_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token exchange failed (${response.status}): ${text}`);
		}

		return response.json() as Promise<TokenResponse>;
	}

	private async _createApiKey(accessToken: string): Promise<CreateApiKeyResponse> {
		const response = await fetch(ANTHROPIC_CREATE_KEY_URL, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name: API_KEY_NAME }),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`API key creation failed (${response.status}): ${text}`);
		}

		return response.json() as Promise<CreateApiKeyResponse>;
	}

	private async _cleanup(): Promise<void> {
		this._isSigningIn = false;
		if (this._callbackServer) {
			await this._callbackServer.stop();
			this._callbackServer = undefined;
		}
	}

	override dispose(): void {
		this.cancel();
		super.dispose();
	}
}

registerSingleton(INyrveOAuthService, NyrveOAuthService, InstantiationType.Delayed);
