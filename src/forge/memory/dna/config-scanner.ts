/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../vs/platform/files/common/files.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { URI } from '../../../vs/base/common/uri.js';

// --- Types ---

export interface TechStackEntry {
	readonly name: string;
	readonly version: string;
	readonly category: string;
	readonly configFile: string;
	readonly detectedFrom: string;
}

export interface ConfigScanResult {
	readonly techStack: TechStackEntry[];
	readonly primaryLanguage: string;
	readonly languages: Array<{ language: string; percentage: number }>;
	readonly projectName: string;
	readonly description: string;
}

// --- Scanner ---

export class ForgeConfigScanner {
	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {}

	async scan(root: URI): Promise<ConfigScanResult> {
		this.logService.info('[Forge] Config scanner: scanning project configuration...');
		const techStack: TechStackEntry[] = [];

		// Scan package.json (Node.js/JS/TS ecosystem)
		const pkg = await this._readJson(root, 'package.json');
		let projectName = '';
		let description = '';

		if (pkg) {
			projectName = String(pkg.name ?? '');
			description = String(pkg.description ?? '');

			// Extract dependencies
			const allDeps: Record<string, unknown> = { ...(pkg.dependencies as Record<string, unknown> ?? {}), ...(pkg.devDependencies as Record<string, unknown> ?? {}) };
			for (const [name, version] of Object.entries(allDeps)) {
				const category = this._categorizeDep(name);
				if (category) {
					techStack.push({
						name,
						version: String(version).replace(/^[~^]/, ''),
						category,
						configFile: 'package.json',
						detectedFrom: 'package.json',
					});
				}
			}
		}

		// Scan pyproject.toml
		const pyproject = await this._readFile(root, 'pyproject.toml');
		if (pyproject) {
			const nameMatch = pyproject.match(/name\s*=\s*"(.+?)"/);
			if (nameMatch && !projectName) {
				projectName = nameMatch[1];
			}
			// Detect Python frameworks
			if (pyproject.includes('django')) {
				techStack.push({ name: 'Django', version: '', category: 'framework', configFile: 'pyproject.toml', detectedFrom: 'pyproject.toml' });
			}
			if (pyproject.includes('flask')) {
				techStack.push({ name: 'Flask', version: '', category: 'framework', configFile: 'pyproject.toml', detectedFrom: 'pyproject.toml' });
			}
			if (pyproject.includes('fastapi')) {
				techStack.push({ name: 'FastAPI', version: '', category: 'framework', configFile: 'pyproject.toml', detectedFrom: 'pyproject.toml' });
			}
		}

		// Scan Cargo.toml
		const cargo = await this._readFile(root, 'Cargo.toml');
		if (cargo) {
			const nameMatch = cargo.match(/name\s*=\s*"(.+?)"/);
			if (nameMatch && !projectName) {
				projectName = nameMatch[1];
			}
		}

		// Scan go.mod
		const gomod = await this._readFile(root, 'go.mod');
		if (gomod) {
			const moduleMatch = gomod.match(/module\s+(.+)/);
			if (moduleMatch && !projectName) {
				projectName = moduleMatch[1].split('/').pop() ?? moduleMatch[1];
			}
		}

		// Detect languages based on config files
		const languages = await this._detectLanguages(root, pkg, pyproject, cargo, gomod);
		const primaryLanguage = languages.length > 0 ? languages[0].language : 'unknown';

		// Detect framework-specific config files
		await this._detectFrameworkConfigs(root, techStack);

		this.logService.info(`[Forge] Config scanner: found ${techStack.length} tech stack entries, primary language: ${primaryLanguage}`);

		return { techStack, primaryLanguage, languages, projectName, description };
	}

	private async _detectLanguages(
		root: URI,
		pkg: Record<string, unknown> | null,
		pyproject: string | null,
		cargo: string | null,
		gomod: string | null,
	): Promise<Array<{ language: string; percentage: number }>> {
		const languages: Array<{ language: string; percentage: number }> = [];

		// Heuristic based on config files present
		const hasTs = await this._exists(root, 'tsconfig.json');
		const hasJs = !!pkg;
		const hasPy = !!pyproject || await this._exists(root, 'setup.py');
		const hasRust = !!cargo;
		const hasGo = !!gomod;

		if (hasTs) {
			languages.push({ language: 'TypeScript', percentage: 70 });
			if (hasJs) {
				languages.push({ language: 'JavaScript', percentage: 30 });
			}
		} else if (hasJs) {
			languages.push({ language: 'JavaScript', percentage: 100 });
		}

		if (hasPy) {
			languages.push({ language: 'Python', percentage: languages.length > 0 ? 30 : 100 });
		}
		if (hasRust) {
			languages.push({ language: 'Rust', percentage: languages.length > 0 ? 30 : 100 });
		}
		if (hasGo) {
			languages.push({ language: 'Go', percentage: languages.length > 0 ? 30 : 100 });
		}

		// Normalize percentages
		const total = languages.reduce((sum, l) => sum + l.percentage, 0);
		if (total > 0) {
			for (const l of languages) {
				(l as { percentage: number }).percentage = Math.round((l.percentage / total) * 100);
			}
		}

		return languages;
	}

	private async _detectFrameworkConfigs(root: URI, techStack: TechStackEntry[]): Promise<void> {
		const frameworkConfigs: Array<{ file: string; name: string; category: string }> = [
			{ file: 'next.config.js', name: 'Next.js', category: 'framework' },
			{ file: 'next.config.mjs', name: 'Next.js', category: 'framework' },
			{ file: 'next.config.ts', name: 'Next.js', category: 'framework' },
			{ file: 'vite.config.ts', name: 'Vite', category: 'build-tool' },
			{ file: 'vite.config.js', name: 'Vite', category: 'build-tool' },
			{ file: 'webpack.config.js', name: 'webpack', category: 'build-tool' },
			{ file: 'tailwind.config.js', name: 'Tailwind CSS', category: 'styling' },
			{ file: 'tailwind.config.ts', name: 'Tailwind CSS', category: 'styling' },
			{ file: '.eslintrc.json', name: 'ESLint', category: 'linter' },
			{ file: 'eslint.config.js', name: 'ESLint', category: 'linter' },
			{ file: '.prettierrc', name: 'Prettier', category: 'formatter' },
			{ file: 'prettier.config.js', name: 'Prettier', category: 'formatter' },
			{ file: 'docker-compose.yml', name: 'Docker Compose', category: 'infrastructure' },
			{ file: 'Dockerfile', name: 'Docker', category: 'infrastructure' },
			{ file: 'prisma/schema.prisma', name: 'Prisma', category: 'orm' },
			{ file: 'drizzle.config.ts', name: 'Drizzle', category: 'orm' },
		];

		const existingNames = new Set(techStack.map(t => t.name));

		for (const config of frameworkConfigs) {
			if (!existingNames.has(config.name) && await this._exists(root, config.file)) {
				techStack.push({
					name: config.name,
					version: '',
					category: config.category,
					configFile: config.file,
					detectedFrom: 'config file',
				});
				existingNames.add(config.name);
			}
		}
	}

	private _categorizeDep(name: string): string | undefined {
		// Major frameworks and libraries
		const categories: Record<string, string> = {
			'react': 'framework', 'next': 'framework', 'vue': 'framework', 'nuxt': 'framework',
			'angular': 'framework', 'svelte': 'framework', 'express': 'framework', 'fastify': 'framework',
			'nestjs': 'framework', 'hono': 'framework',
			'prisma': 'orm', 'drizzle-orm': 'orm', 'typeorm': 'orm', 'sequelize': 'orm', 'mongoose': 'orm',
			'jest': 'testing', 'vitest': 'testing', 'mocha': 'testing', 'cypress': 'testing', 'playwright': 'testing',
			'tailwindcss': 'styling', 'styled-components': 'styling', 'emotion': 'styling',
			'typescript': 'language', 'esbuild': 'build-tool', 'rollup': 'build-tool', 'turbo': 'build-tool',
			'redis': 'database', 'pg': 'database', 'mysql2': 'database', 'mongodb': 'database',
			'bullmq': 'queue', 'zod': 'validation', 'trpc': 'api',
		};

		// Check if the dep name starts with or matches any category key
		for (const [key, category] of Object.entries(categories)) {
			if (name === key || name === `@${key}/core` || name.startsWith(`@${key}/`)) {
				return category;
			}
		}

		return undefined;
	}

	private async _readJson(root: URI, path: string): Promise<Record<string, unknown> | null> {
		try {
			const content = await this.fileService.readFile(URI.joinPath(root, path));
			return JSON.parse(content.value.toString());
		} catch {
			return null;
		}
	}

	private async _readFile(root: URI, path: string): Promise<string | null> {
		try {
			const content = await this.fileService.readFile(URI.joinPath(root, path));
			return content.value.toString();
		} catch {
			return null;
		}
	}

	private async _exists(root: URI, path: string): Promise<boolean> {
		try {
			await this.fileService.stat(URI.joinPath(root, path));
			return true;
		} catch {
			return false;
		}
	}
}
