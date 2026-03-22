/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gulp 5 added an `encoding` option to gulp.src() but @types/vinyl-fs
// has not been updated yet. This augmentation adds it to suppress TS2353.

import 'vinyl-fs';

declare module 'vinyl-fs' {
	interface SrcOptions {
		encoding?: BufferEncoding | false;
	}
}
