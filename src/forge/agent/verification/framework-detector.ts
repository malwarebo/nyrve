/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IFileService } from '../../../vs/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../vs/platform/workspace/common/workspace.js';
import { URI } from '../../../vs/base/common/uri.js';

// --- Types ---

export interface TestRunnerConfig {
	readonly detected: boolean;
	readonly framework: string;
	readonly command: string;
	readonly relevantTestCommand: string;
	readonly coverageCommand: string;
	readonly timeout: number;
	readonly jsonOutputFlag: string;
}

export interface TypeCheckerConfig {
	readonly detected: boolean;
	readonly checker: string;
	readonly command: string;
}

export interface FrameworkDetectionResult {
	readonly testRunner: TestRunnerConfig;
	readonly typeChecker: TypeCheckerConfig;
}

// --- Service Interface ---

export const IForgeFrameworkDetector = createDecorator<IForgeFrameworkDetector>('forgeFrameworkDetector');

export interface IForgeFrameworkDetector {
	readonly _serviceBrand: undefined;

	/** Detect the project's test framework and type checker. */
	detect(): Promise<FrameworkDetectionResult>;

	/** Get cached detection result, or run detection if not cached. */
	getDetectionResult(): Promise<FrameworkDetectionResult>;
}

// --- Helpers ---

const NO_TEST_RUNNER: TestRunnerConfig = {
	detected: false,
	framework: '',
	command: '',
	relevantTestCommand: '',
	coverageCommand: '',
	timeout: 60000,
	jsonOutputFlag: '',
};

const NO_TYPE_CHECKER: TypeCheckerConfig = {
	detected: false,
	checker: '',
	command: '',
};

// --- Service Implementation ---

export class ForgeFrameworkDetector extends Disposable implements IForgeFrameworkDetector {
	declare readonly _serviceBrand: undefined;

	private _cachedResult: FrameworkDetectionResult | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async getDetectionResult(): Promise<FrameworkDetectionResult> {
		if (!this._cachedResult) {
			this._cachedResult = await this.detect();
		}
		return this._cachedResult;
	}

	async detect(): Promise<FrameworkDetectionResult> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			this.logService.warn('[Forge] No workspace root found for framework detection');
			return { testRunner: NO_TEST_RUNNER, typeChecker: NO_TYPE_CHECKER };
		}

		this.logService.info('[Forge] Detecting project frameworks...');

		const [testRunner, typeChecker] = await Promise.all([
			this._detectTestRunner(root),
			this._detectTypeChecker(root),
		]);

		this._cachedResult = { testRunner, typeChecker };

		this.logService.info(
			`[Forge] Detection complete: test=${testRunner.detected ? testRunner.framework : 'none'}, ` +
			`type=${typeChecker.detected ? typeChecker.checker : 'none'}`
		);

		return this._cachedResult;
	}

	// --- Test Runner Detection ---

	private async _detectTestRunner(root: URI): Promise<TestRunnerConfig> {
		// Check Jest
		if (await this._fileExists(root, 'jest.config.js') ||
			await this._fileExists(root, 'jest.config.ts') ||
			await this._fileExists(root, 'jest.config.mjs') ||
			await this._fileExists(root, 'jest.config.cjs') ||
			await this._packageJsonHasDep(root, 'jest')) {
			return {
				detected: true,
				framework: 'jest',
				command: 'npx jest --json',
				relevantTestCommand: 'npx jest --json --findRelatedTests {files}',
				coverageCommand: 'npx jest --coverage --coverageReporters=json',
				timeout: 60000,
				jsonOutputFlag: '--json',
			};
		}

		// Check Vitest
		if (await this._fileExists(root, 'vitest.config.js') ||
			await this._fileExists(root, 'vitest.config.ts') ||
			await this._fileExists(root, 'vitest.config.mjs') ||
			await this._fileExists(root, 'vitest.config.mts') ||
			await this._packageJsonHasDep(root, 'vitest')) {
			return {
				detected: true,
				framework: 'vitest',
				command: 'npx vitest run --reporter=json',
				relevantTestCommand: 'npx vitest run --reporter=json {testFiles}',
				coverageCommand: 'npx vitest run --coverage --coverage.reporter=json',
				timeout: 60000,
				jsonOutputFlag: '--reporter=json',
			};
		}

		// Check pytest
		if (await this._fileExists(root, 'pytest.ini') ||
			await this._fileExists(root, 'conftest.py') ||
			await this._pyprojectHasPytest(root)) {
			return {
				detected: true,
				framework: 'pytest',
				command: 'python -m pytest --tb=short -q',
				relevantTestCommand: 'python -m pytest --tb=short -q {testFiles}',
				coverageCommand: 'python -m pytest --cov --cov-report=json',
				timeout: 60000,
				jsonOutputFlag: '--tb=short -q',
			};
		}

		// Check Go test
		if (await this._fileExists(root, 'go.mod')) {
			return {
				detected: true,
				framework: 'go test',
				command: 'go test ./... -json',
				relevantTestCommand: 'go test -json {packages}',
				coverageCommand: 'go test ./... -coverprofile=coverage.out',
				timeout: 60000,
				jsonOutputFlag: '-json',
			};
		}

		// Check Cargo test
		if (await this._fileExists(root, 'Cargo.toml')) {
			return {
				detected: true,
				framework: 'cargo test',
				command: 'cargo test -- --format json',
				relevantTestCommand: 'cargo test {testNames} -- --format json',
				coverageCommand: 'cargo tarpaulin --out json',
				timeout: 60000,
				jsonOutputFlag: '-- --format json',
			};
		}

		// Check RSpec
		if (await this._fileExists(root, '.rspec') ||
			await this._gemfileHas(root, 'rspec')) {
			return {
				detected: true,
				framework: 'rspec',
				command: 'bundle exec rspec --format json',
				relevantTestCommand: 'bundle exec rspec {testFiles} --format json',
				coverageCommand: 'bundle exec rspec --format json',
				timeout: 60000,
				jsonOutputFlag: '--format json',
			};
		}

		return NO_TEST_RUNNER;
	}

	// --- Type Checker Detection ---

	private async _detectTypeChecker(root: URI): Promise<TypeCheckerConfig> {
		// Check TypeScript
		if (await this._fileExists(root, 'tsconfig.json') ||
			await this._fileExists(root, 'tsconfig.base.json') ||
			await this._fileExists(root, 'jsconfig.json')) {
			return {
				detected: true,
				checker: 'tsc',
				command: 'npx tsc --noEmit',
			};
		}

		// Check Pyright
		if (await this._fileExists(root, 'pyrightconfig.json') ||
			await this._pyprojectHas(root, 'pyright')) {
			return {
				detected: true,
				checker: 'pyright',
				command: 'npx pyright',
			};
		}

		// Check mypy
		if (await this._fileExists(root, 'mypy.ini') ||
			await this._fileExists(root, '.mypy.ini') ||
			await this._pyprojectHas(root, 'mypy')) {
			return {
				detected: true,
				checker: 'mypy',
				command: 'mypy .',
			};
		}

		// Check Cargo (Rust)
		if (await this._fileExists(root, 'Cargo.toml')) {
			return {
				detected: true,
				checker: 'cargo check',
				command: 'cargo check',
			};
		}

		// Check Go
		if (await this._fileExists(root, 'go.mod')) {
			return {
				detected: true,
				checker: 'go vet',
				command: 'go vet ./...',
			};
		}

		return NO_TYPE_CHECKER;
	}

	// --- File Utility Helpers ---

	private _getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private async _fileExists(root: URI, relativePath: string): Promise<boolean> {
		try {
			const uri = URI.joinPath(root, relativePath);
			const stat = await this.fileService.stat(uri);
			return !!stat;
		} catch {
			return false;
		}
	}

	private async _readFileContent(root: URI, relativePath: string): Promise<string | undefined> {
		try {
			const uri = URI.joinPath(root, relativePath);
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	private async _packageJsonHasDep(root: URI, depName: string): Promise<boolean> {
		const content = await this._readFileContent(root, 'package.json');
		if (!content) {
			return false;
		}
		try {
			const pkg = JSON.parse(content);
			return !!(
				pkg.dependencies?.[depName] ||
				pkg.devDependencies?.[depName] ||
				pkg.scripts?.test?.includes(depName)
			);
		} catch {
			return false;
		}
	}

	private async _pyprojectHasPytest(root: URI): Promise<boolean> {
		const content = await this._readFileContent(root, 'pyproject.toml');
		if (!content) {
			return false;
		}
		return content.includes('[tool.pytest') || content.includes('pytest');
	}

	private async _pyprojectHas(root: URI, tool: string): Promise<boolean> {
		const content = await this._readFileContent(root, 'pyproject.toml');
		if (!content) {
			return false;
		}
		return content.includes(`[tool.${tool}`) || content.includes(tool);
	}

	private async _gemfileHas(root: URI, gem: string): Promise<boolean> {
		const content = await this._readFileContent(root, 'Gemfile');
		if (!content) {
			return false;
		}
		return content.includes(`'${gem}'`) || content.includes(`"${gem}"`);
	}
}

registerSingleton(IForgeFrameworkDetector, ForgeFrameworkDetector, InstantiationType.Delayed);
