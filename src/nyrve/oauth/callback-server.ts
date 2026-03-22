/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Temporary localhost HTTP server that receives the OAuth callback
 * from Anthropic after the user authorizes. Extracts the authorization
 * code and state, then shuts down.
 */

import type * as http from 'http';
import { DeferredPromise } from '../../vs/base/common/async.js';

export interface OAuthCallbackResult {
	readonly code: string;
	readonly state: string;
}

const CALLBACK_TIMEOUT_MS = 300_000; // 5 minutes
const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Nyrve</title><style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1e1d1a; color: #e8e6de; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
.card { text-align: center; padding: 40px; }
h1 { font-size: 24px; margin-bottom: 8px; }
p { color: #9a9890; font-size: 14px; }
</style></head>
<body><div class="card">
<h1>Signed in to Nyrve</h1>
<p>You can close this tab and return to the editor.</p>
</div></body>
</html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html>
<head><title>Nyrve</title><style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1e1d1a; color: #e8e6de; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
.card { text-align: center; padding: 40px; }
h1 { font-size: 24px; margin-bottom: 8px; color: #E24B4A; }
p { color: #9a9890; font-size: 14px; }
</style></head>
<body><div class="card">
<h1>Authentication Failed</h1>
<p>${msg}</p>
</div></body>
</html>`;

export class NyrveOAuthCallbackServer {
	private _server: http.Server | undefined;
	private _port: number | undefined;
	private _timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	get port(): number {
		if (this._port === undefined) {
			throw new Error('Callback server not started');
		}
		return this._port;
	}

	get redirectUri(): string {
		return `http://127.0.0.1:${this.port}/callback`;
	}

	/**
	 * Start the callback server on a random available port.
	 * Returns a promise that resolves when the server is listening.
	 */
	async start(): Promise<void> {
		if (this._server) {
			throw new Error('Callback server already running');
		}

		const httpModule = await import('http');
		const listening = new DeferredPromise<void>();

		this._server = httpModule.createServer((req, res) => {
			this._handleRequest(req, res);
		});

		this._server.on('listening', () => {
			const address = this._server!.address();
			if (address && typeof address === 'object') {
				this._port = address.port;
			}
			listening.complete();
		});

		this._server.on('error', (err) => {
			listening.error(err);
		});

		// Listen on random available port, localhost only
		this._server.listen(0, '127.0.0.1');

		return listening.p;
	}

	/**
	 * Wait for the OAuth callback. Returns the authorization code + state.
	 * Times out after 5 minutes.
	 */
	waitForCallback(): Promise<OAuthCallbackResult> {
		this._callbackPromise = new DeferredPromise<OAuthCallbackResult>();

		this._timeoutHandle = setTimeout(() => {
			this._callbackPromise?.error(new Error('OAuth callback timed out'));
			this.stop();
		}, CALLBACK_TIMEOUT_MS);

		return this._callbackPromise.p;
	}

	/**
	 * Stop the callback server and clean up.
	 */
	async stop(): Promise<void> {
		if (this._timeoutHandle) {
			clearTimeout(this._timeoutHandle);
			this._timeoutHandle = undefined;
		}

		if (this._server) {
			const server = this._server;
			this._server = undefined;
			this._port = undefined;

			return new Promise<void>((resolve) => {
				server.close(() => resolve());
				// Force close after 2 seconds
				setTimeout(() => resolve(), 2000);
			});
		}
	}

	private _callbackPromise: DeferredPromise<OAuthCallbackResult> | undefined;

	private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

		if (url.pathname === '/callback') {
			const error = url.searchParams.get('error');
			if (error) {
				const desc = url.searchParams.get('error_description') ?? error;
				this._sendHtml(res, 400, ERROR_HTML(desc));
				this._callbackPromise?.error(new Error(desc));
				return;
			}

			// Anthropic returns code#state or code as query param
			let code = url.searchParams.get('code');
			let state = url.searchParams.get('state');

			// Handle Anthropic's code#state format in the hash
			if (code && code.includes('#')) {
				const parts = code.split('#');
				code = parts[0];
				state = parts[1] ?? state;
			}

			if (!code) {
				this._sendHtml(res, 400, ERROR_HTML('Missing authorization code'));
				this._callbackPromise?.error(new Error('Missing authorization code'));
				return;
			}

			this._sendHtml(res, 200, SUCCESS_HTML);
			this._callbackPromise?.complete({ code, state: state ?? '' });
		} else {
			res.writeHead(404);
			res.end();
		}
	}

	private _sendHtml(res: http.ServerResponse, status: number, html: string): void {
		res.writeHead(status, {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Length': Buffer.byteLength(html, 'utf8'),
			'Cache-Control': 'no-store',
		});
		res.end(html);
	}
}
