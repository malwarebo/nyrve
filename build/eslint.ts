/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import eventStream from 'event-stream';
import vfs from 'vinyl-fs';
import { eslintFilter } from './filters.ts';
import gulpEslint from './gulp-eslint.ts';

function eslint(): NodeJS.ReadWriteStream {
	return vfs
		.src(Array.from(eslintFilter), { base: '.', follow: true, allowEmpty: true })
		.pipe(
			gulpEslint((results) => {
				if (results.errorCount > 0) {
					throw new Error(`eslint failed with ${results.errorCount} errors`);
				}
				if (results.warningCount > 0) {
					console.log(`eslint completed with ${results.warningCount} warnings`);
				}
			})
		).pipe(eventStream.through(function () { /* noop, important for the stream to end */ }));
}

if (import.meta.main) {
	eslint().on('error', (err) => {
		console.error();
		console.error(err);
		process.exit(1);
	});
}
