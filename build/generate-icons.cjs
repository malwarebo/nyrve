/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Generates all Nyrve icon assets from the master SVG.
 *
 * Usage: node build/generate-icons.js
 *
 * Requires: @resvg/resvg-js, png-to-ico (devDependencies)
 * macOS: also uses `iconutil` to create .icns
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Resvg } = require('@resvg/resvg-js');
/**
 * Create an ICO file from PNG buffers.
 * ICO format: header (6 bytes) + directory entries (16 bytes each) + image data.
 * We store PNGs directly (modern ICO supports embedded PNG).
 * @param {Buffer[]} pngBuffers
 * @param {number[]} sizes - corresponding pixel sizes
 * @returns {Buffer}
 */
function createIco(pngBuffers, sizes) {
	const numImages = pngBuffers.length;
	const headerSize = 6;
	const dirEntrySize = 16;
	const dirSize = dirEntrySize * numImages;
	let dataOffset = headerSize + dirSize;

	// Header: reserved(2) + type(2, 1=ICO) + count(2)
	const header = Buffer.alloc(headerSize);
	header.writeUInt16LE(0, 0);       // Reserved
	header.writeUInt16LE(1, 2);       // Type: 1 = ICO
	header.writeUInt16LE(numImages, 4);

	// Directory entries
	const dirEntries = Buffer.alloc(dirSize);
	const offsets = [];
	for (let i = 0; i < numImages; i++) {
		const size = sizes[i];
		const pngData = pngBuffers[i];
		const offset = i * dirEntrySize;

		dirEntries.writeUInt8(size >= 256 ? 0 : size, offset);      // Width (0 = 256)
		dirEntries.writeUInt8(size >= 256 ? 0 : size, offset + 1);  // Height (0 = 256)
		dirEntries.writeUInt8(0, offset + 2);                        // Color palette
		dirEntries.writeUInt8(0, offset + 3);                        // Reserved
		dirEntries.writeUInt16LE(1, offset + 4);                     // Color planes
		dirEntries.writeUInt16LE(32, offset + 6);                    // Bits per pixel
		dirEntries.writeUInt32LE(pngData.length, offset + 8);        // Data size
		dirEntries.writeUInt32LE(dataOffset, offset + 12);           // Data offset

		offsets.push(dataOffset);
		dataOffset += pngData.length;
	}

	return Buffer.concat([header, dirEntries, ...pngBuffers]);
}

const ROOT = path.join(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'resources', 'nyrve', 'icons');
const FAVICON_DIR = path.join(ROOT, 'resources', 'nyrve', 'favicon');
const LOGO_DIR = path.join(ROOT, 'resources', 'nyrve', 'logo');

const MASTER_SVG = path.join(ICONS_DIR, 'nyrve.svg');
const LIGHT_SVG = path.join(ICONS_DIR, 'nyrve-light.svg');

// PNG sizes to generate from the master (dark bg) SVG
const MASTER_SIZES = [1024, 512, 256, 128, 96, 80, 64, 48, 32, 16];

// PNG sizes to generate from the light (transparent bg) SVG
const LIGHT_SIZES = [512, 256, 128, 48, 32];

// ICO sizes (embedded in nyrve.ico)
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Render an SVG string to a PNG buffer at the given size.
 * @param {string} svgString
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function renderSvgToPng(svgString, width, height) {
	const resvg = new Resvg(svgString, {
		fitTo: { mode: 'width', value: width },
		background: 'rgba(0,0,0,0)',
	});
	const rendered = resvg.render();
	return rendered.asPng();
}

/**
 * Create an SVG for apple-touch-icon: flame centered on solid background.
 * @param {string} svgContent - The master SVG content
 * @param {number} size
 * @returns {Buffer}
 */
function renderAppleTouchIcon(svgContent, size) {
	// The master SVG already has the dark background, render it at 180x180
	return renderSvgToPng(svgContent, size, size);
}

async function main() {
	console.log('Nyrve Icon Generator');
	console.log('====================\n');

	// Ensure output directories exist
	for (const dir of [ICONS_DIR, FAVICON_DIR, LOGO_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// Read source SVGs
	const masterSvg = fs.readFileSync(MASTER_SVG, 'utf-8');
	const lightSvg = fs.readFileSync(LIGHT_SVG, 'utf-8');

	// --- Step 1: Master PNGs ---
	console.log('Generating master PNGs...');
	for (const size of MASTER_SIZES) {
		const png = renderSvgToPng(masterSvg, size, size);
		const outPath = path.join(ICONS_DIR, `nyrve-${size}.png`);
		fs.writeFileSync(outPath, png);
		console.log(`  nyrve-${size}.png (${png.length} bytes)`);
	}

	// --- Step 2: Light variant PNGs ---
	console.log('\nGenerating light variant PNGs...');
	for (const size of LIGHT_SIZES) {
		const png = renderSvgToPng(lightSvg, size, size);
		const outPath = path.join(ICONS_DIR, `nyrve-light-${size}.png`);
		fs.writeFileSync(outPath, png);
		console.log(`  nyrve-light-${size}.png (${png.length} bytes)`);
	}

	// --- Step 3: Favicons ---
	console.log('\nGenerating favicons...');

	// favicon-16x16.png and favicon-32x32.png
	const fav16 = renderSvgToPng(masterSvg, 16, 16);
	const fav32 = renderSvgToPng(masterSvg, 32, 32);
	fs.writeFileSync(path.join(FAVICON_DIR, 'favicon-16x16.png'), fav16);
	fs.writeFileSync(path.join(FAVICON_DIR, 'favicon-32x32.png'), fav32);
	console.log('  favicon-16x16.png, favicon-32x32.png');

	// favicon.ico (16 + 32)
	const favIco = createIco([fav16, fav32], [16, 32]);
	fs.writeFileSync(path.join(FAVICON_DIR, 'favicon.ico'), favIco);
	console.log('  favicon.ico');

	// apple-touch-icon.png (180x180 with dark bg)
	const appleTouchPng = renderAppleTouchIcon(masterSvg, 180);
	fs.writeFileSync(path.join(FAVICON_DIR, 'apple-touch-icon.png'), appleTouchPng);
	console.log('  apple-touch-icon.png (180x180)');

	// android-chrome PNGs
	const android192 = renderSvgToPng(masterSvg, 192, 192);
	const android512 = renderSvgToPng(masterSvg, 512, 512);
	fs.writeFileSync(path.join(FAVICON_DIR, 'android-chrome-192.png'), android192);
	fs.writeFileSync(path.join(FAVICON_DIR, 'android-chrome-512.png'), android512);
	console.log('  android-chrome-192.png, android-chrome-512.png');

	// site.webmanifest
	const manifest = {
		name: 'Nyrve',
		short_name: 'Nyrve',
		icons: [
			{ src: '/android-chrome-192.png', sizes: '192x192', type: 'image/png' },
			{ src: '/android-chrome-512.png', sizes: '512x512', type: 'image/png' },
		],
		theme_color: '#1f1e1a',
		background_color: '#1f1e1a',
		display: 'standalone',
	};
	fs.writeFileSync(
		path.join(FAVICON_DIR, 'site.webmanifest'),
		JSON.stringify(manifest, null, '\t') + '\n'
	);
	console.log('  site.webmanifest');

	// --- Step 4: nyrve.ico (Windows, multiple sizes) ---
	console.log('\nGenerating nyrve.ico...');
	const icoPngBuffers = [];
	for (const size of ICO_SIZES) {
		icoPngBuffers.push(renderSvgToPng(masterSvg, size, size));
	}
	const icoBuffer = createIco(icoPngBuffers, ICO_SIZES);
	fs.writeFileSync(path.join(ICONS_DIR, 'nyrve.ico'), icoBuffer);
	console.log('  nyrve.ico (' + ICO_SIZES.join(', ') + ')');

	// --- Step 5: nyrve.icns (macOS) ---
	if (process.platform === 'darwin') {
		console.log('\nGenerating nyrve.icns (macOS)...');
		const iconsetDir = path.join(ICONS_DIR, 'nyrve.iconset');
		fs.mkdirSync(iconsetDir, { recursive: true });

		// iconutil requires specific naming: icon_NxN.png and icon_NxN@2x.png
		const icnsEntries = [
			{ name: 'icon_16x16.png', size: 16 },
			{ name: 'icon_16x16@2x.png', size: 32 },
			{ name: 'icon_32x32.png', size: 32 },
			{ name: 'icon_32x32@2x.png', size: 64 },
			{ name: 'icon_128x128.png', size: 128 },
			{ name: 'icon_128x128@2x.png', size: 256 },
			{ name: 'icon_256x256.png', size: 256 },
			{ name: 'icon_256x256@2x.png', size: 512 },
			{ name: 'icon_512x512.png', size: 512 },
			{ name: 'icon_512x512@2x.png', size: 1024 },
		];

		for (const entry of icnsEntries) {
			const png = renderSvgToPng(masterSvg, entry.size, entry.size);
			fs.writeFileSync(path.join(iconsetDir, entry.name), png);
		}

		try {
			execSync(`iconutil -c icns -o "${path.join(ICONS_DIR, 'nyrve.icns')}" "${iconsetDir}"`);
			console.log('  nyrve.icns');
		} catch (e) {
			console.warn('  WARNING: iconutil failed:', e.message);
		}

		// Clean up iconset
		for (const f of fs.readdirSync(iconsetDir)) {
			fs.unlinkSync(path.join(iconsetDir, f));
		}
		fs.rmdirSync(iconsetDir);
	} else {
		console.log('\nSkipping nyrve.icns (not on macOS)');
	}

	// --- Step 6: Copy to logo dir (convenience copies) ---
	console.log('\nCopying logo variants...');
	fs.copyFileSync(path.join(ICONS_DIR, 'nyrve.svg'), path.join(LOGO_DIR, 'nyrve.svg'));
	fs.copyFileSync(path.join(ICONS_DIR, 'nyrve-light.svg'), path.join(LOGO_DIR, 'nyrve-light.svg'));
	fs.copyFileSync(path.join(ICONS_DIR, 'nyrve-512.png'), path.join(LOGO_DIR, 'nyrve-512.png'));
	console.log('  nyrve.svg, nyrve-light.svg, nyrve-512.png');

	// --- Step 7: Copy to platform directories ---
	console.log('\nCopying to platform directories...');

	const platformCopies = [
		{ src: 'nyrve.icns', dest: path.join(ROOT, 'resources', 'darwin', 'nyrve.icns') },
		{ src: 'nyrve.ico', dest: path.join(ROOT, 'resources', 'win32', 'nyrve.ico') },
		{ src: 'nyrve-128.png', dest: path.join(ROOT, 'resources', 'linux', 'nyrve.png') },
		{ src: 'nyrve-512.png', dest: path.join(ROOT, 'resources', 'linux', 'nyrve-512.png') },
	];

	for (const { src, dest } of platformCopies) {
		const srcPath = path.join(ICONS_DIR, src);
		if (fs.existsSync(srcPath)) {
			fs.copyFileSync(srcPath, dest);
			console.log(`  ${src} -> ${path.relative(ROOT, dest)}`);
		} else {
			console.warn(`  WARNING: ${src} not found, skipping platform copy`);
		}
	}

	console.log('\nDone! All icons generated successfully.');
}

main().catch(err => {
	console.error('Icon generation failed:', err);
	process.exit(1);
});
