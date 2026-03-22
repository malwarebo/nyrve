/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0.
 * Generates cryptographically secure code verifier/challenge pairs
 * per RFC 7636, using SHA-256 as the challenge method.
 */

export interface PkcePair {
	readonly verifier: string;
	readonly challenge: string;
}

/**
 * Generate a PKCE code verifier (43-128 character URL-safe string)
 * and its corresponding SHA-256 challenge.
 */
export async function generatePkce(): Promise<PkcePair> {
	const { randomBytes } = await import('crypto');
	const buffer = randomBytes(32);
	const verifier = base64UrlEncode(buffer);
	const challenge = await sha256Base64Url(verifier);
	return { verifier, challenge };
}

/**
 * Generate a cryptographically random state parameter for CSRF protection.
 */
export async function generateState(): Promise<string> {
	const { randomBytes } = await import('crypto');
	return base64UrlEncode(randomBytes(16));
}

async function sha256Base64Url(input: string): Promise<string> {
	const { createHash } = await import('crypto');
	const hash = createHash('sha256').update(input).digest();
	return base64UrlEncode(hash);
}

function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
