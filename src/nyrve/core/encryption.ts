/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';

// --- Service Interface ---

export const INyrveEncryption = createDecorator<INyrveEncryption>('nyrveEncryption');

export interface INyrveEncryption {
	readonly _serviceBrand: undefined;

	/** Encrypt a string using the workspace encryption key. */
	encrypt(plaintext: string): Promise<string>;

	/** Decrypt a string using the workspace encryption key. */
	decrypt(ciphertext: string): Promise<string>;

	/** Check if encryption is available. */
	isAvailable(): boolean;

	/** Derive a key from a passphrase (for initial key setup). */
	deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey>;
}

// --- Service Implementation ---

/**
 * Encryption service using the Web Crypto API (available in Electron's renderer).
 * Uses AES-GCM with 256-bit keys for authenticated encryption.
 */
export class NyrveEncryption extends Disposable implements INyrveEncryption {
	declare readonly _serviceBrand: undefined;

	private _key: CryptoKey | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	isAvailable(): boolean {
		return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
	}

	async encrypt(plaintext: string): Promise<string> {
		if (!this._key) {
			// Without a key, return base64-encoded plaintext as a fallback
			return VSBuffer.fromString(plaintext).toString();
		}

		try {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const encoded = new TextEncoder().encode(plaintext);

			const encrypted = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				this._key,
				encoded
			);

			// Combine IV + ciphertext and base64 encode
			const combined = new Uint8Array(iv.length + encrypted.byteLength);
			combined.set(iv, 0);
			combined.set(new Uint8Array(encrypted), iv.length);

			return btoa(String.fromCharCode(...combined));
		} catch (e) {
			this.logService.warn(`[Nyrve] Encryption failed: ${e}`);
			throw new Error('Encryption failed');
		}
	}

	async decrypt(ciphertext: string): Promise<string> {
		if (!this._key) {
			// Without a key, assume it's base64-encoded plaintext
			return VSBuffer.wrap(new TextEncoder().encode(atob(ciphertext))).toString();
		}

		try {
			const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
			const iv = combined.slice(0, 12);
			const data = combined.slice(12);

			const decrypted = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv },
				this._key,
				data
			);

			return new TextDecoder().decode(decrypted);
		} catch (e) {
			this.logService.warn(`[Nyrve] Decryption failed: ${e}`);
			throw new Error('Decryption failed');
		}
	}

	async deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
		const keyMaterial = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(passphrase),
			'PBKDF2',
			false,
			['deriveKey']
		);

		this._key = await crypto.subtle.deriveKey(
			{
				name: 'PBKDF2',
				salt: salt as BufferSource,
				iterations: 100000,
				hash: 'SHA-256',
			} as Pbkdf2Params,
			keyMaterial,
			{ name: 'AES-GCM', length: 256 } as AesKeyGenParams,
			false,
			['encrypt', 'decrypt']
		);

		this.logService.info('[Nyrve] Encryption key derived successfully');
		return this._key;
	}
}

registerSingleton(INyrveEncryption, NyrveEncryption, InstantiationType.Delayed);
