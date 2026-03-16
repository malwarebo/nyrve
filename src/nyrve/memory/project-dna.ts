/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { URI } from '../../vs/base/common/uri.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';
import { INyrveIndexManager } from '../indexer/index-manager.js';
import { INyrveAgentEngine } from '../agent/agent-engine.js';
import { INyrveModelRouter } from '../agent/model-router.js';
import { NyrveConfigScanner, TechStackEntry } from './dna/config-scanner.js';
import { NyrveStructureScanner, ModuleInfo, DependencyEdge } from './dna/structure-scanner.js';
import { NyrveGitAnalyzer, FileHotspot, FileCoupling } from './dna/git-analyzer.js';
import { NyrveComplexityAnalyzer, TechDebtItem } from './dna/complexity-analyzer.js';
import { NyrvePatternDetector, CodePattern, Convention } from './dna/pattern-detector.js';
import { compressDNA } from './dna/dna-compressor.js';

// --- Types ---

export interface ProjectDNA {
	projectName: string;
	description: string;
	primaryLanguage: string;
	languages: Array<{ language: string; percentage: number }>;
	techStack: TechStackEntry[];

	architecture: {
		type: string;
		entryPoints: string[];
		moduleMap: ModuleInfo[];
		dependencyGraph: DependencyEdge[];
		layering: string[];
	};

	patterns: CodePattern[];
	conventions: Convention[];

	testing: {
		framework: string;
		testDirectory: string;
		namingConvention: string;
		coveragePercent: number;
		totalTests: number;
	};

	git: {
		totalCommits: number;
		activeContributors: number;
		hotspots: FileHotspot[];
		couplings: FileCoupling[];
		churnRate: number;
		branchStrategy: string;
	};

	complexity: {
		largestFiles: Array<{ path: string; lines: number }>;
		mostComplexFunctions: Array<{ path: string; name: string; cyclomaticComplexity: number }>;
		techDebt: TechDebtItem[];
	};

	lastFullScan: string;
	lastIncrementalUpdate: string;
	scanDuration: number;
}

// --- Service Interface ---

export const INyrveProjectDNA = createDecorator<INyrveProjectDNA>('nyrveProjectDNA');

export interface INyrveProjectDNA {
	readonly _serviceBrand: undefined;

	/** Fires when a DNA scan completes. */
	readonly onDidScanComplete: Event<ProjectDNA>;

	/** Run a full DNA scan. */
	fullScan(): Promise<ProjectDNA>;

	/** Get the current DNA (from cache or file). Returns undefined if no scan has been done. */
	getDNA(): ProjectDNA | undefined;

	/** Get a compressed summary suitable for agent system prompts (~1-2K tokens). */
	getCompressedSummary(): string;

	/** Incrementally update DNA for a specific file change. */
	incrementalUpdate(filePath: string): Promise<void>;
}

// --- Service Implementation ---

export class NyrveProjectDNAService extends Disposable implements INyrveProjectDNA {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidScanComplete = this._register(new Emitter<ProjectDNA>());
	readonly onDidScanComplete: Event<ProjectDNA> = this._onDidScanComplete.event;

	private _dna: ProjectDNA | undefined;
	private _compressedSummary: string = '';

	private readonly configScanner: NyrveConfigScanner;
	private readonly structureScanner: NyrveStructureScanner;
	private readonly gitAnalyzer: NyrveGitAnalyzer;
	private readonly complexityAnalyzer: NyrveComplexityAnalyzer;
	private readonly patternDetector: NyrvePatternDetector;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@INyrveIndexManager indexManager: INyrveIndexManager,
		@INyrveAgentEngine agentEngine: INyrveAgentEngine,
		@INyrveModelRouter modelRouter: INyrveModelRouter,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.configScanner = new NyrveConfigScanner(fileService, logService);
		this.structureScanner = new NyrveStructureScanner(indexManager, logService);
		this.gitAnalyzer = new NyrveGitAnalyzer(workspaceContextService, logService);
		this.complexityAnalyzer = new NyrveComplexityAnalyzer(indexManager, workspaceContextService, logService);
		this.patternDetector = new NyrvePatternDetector(agentEngine, modelRouter, indexManager, logService);

		// Try to load from disk on init
		this._loadFromDisk();
	}

	getDNA(): ProjectDNA | undefined {
		return this._dna;
	}

	getCompressedSummary(): string {
		return this._compressedSummary;
	}

	async fullScan(): Promise<ProjectDNA> {
		const enabled = this.configurationService.getValue<boolean>('nyrve.memory.dna.enabled') ?? true;
		if (!enabled) {
			this.logService.info('[Nyrve] Project DNA scanning is disabled');
			return this._emptyDNA();
		}

		const startTime = Date.now();
		this.logService.info('[Nyrve] Starting full DNA scan...');

		const root = this._getWorkspaceRoot();
		if (!root) {
			return this._emptyDNA();
		}

		const historyDays = this.configurationService.getValue<number>('nyrve.memory.dna.gitHistoryDays') ?? 90;

		try {
			// Run all scanners in parallel
			const [configResult, structureResult, gitResult, complexityResult, patternResult] = await Promise.all([
				this.configScanner.scan(root),
				this.structureScanner.scan(),
				this.gitAnalyzer.analyze(historyDays),
				this.complexityAnalyzer.analyze(),
				this.patternDetector.detect(),
			]);

			const scanDuration = Date.now() - startTime;

			// Detect testing info from framework detector data
			const testingInfo = this._buildTestingInfo(configResult);

			// Assemble ProjectDNA
			const dna: ProjectDNA = {
				projectName: configResult.projectName,
				description: configResult.description,
				primaryLanguage: configResult.primaryLanguage,
				languages: configResult.languages,
				techStack: configResult.techStack,

				architecture: {
					type: structureResult.architectureType,
					entryPoints: structureResult.entryPoints,
					moduleMap: structureResult.modules,
					dependencyGraph: structureResult.dependencyGraph,
					layering: structureResult.layering,
				},

				patterns: patternResult.patterns,
				conventions: patternResult.conventions,

				testing: testingInfo,

				git: gitResult,

				complexity: complexityResult,

				lastFullScan: new Date().toISOString(),
				lastIncrementalUpdate: new Date().toISOString(),
				scanDuration,
			};

			// Save and compress
			this._dna = dna;
			this._compressedSummary = compressDNA(dna);
			await this._saveToDisk(dna);

			this.logService.info(`[Nyrve] Full DNA scan complete in ${scanDuration}ms`);
			this._onDidScanComplete.fire(dna);

			return dna;
		} catch (error) {
			this.logService.error(`[Nyrve] DNA scan failed: ${error}`);
			return this._emptyDNA();
		}
	}

	async incrementalUpdate(filePath: string): Promise<void> {
		if (!this._dna) {
			return;
		}

		const enabled = this.configurationService.getValue<boolean>('nyrve.memory.dna.incrementalUpdates') ?? true;
		if (!enabled) {
			return;
		}

		this.logService.trace(`[Nyrve] DNA incremental update for: ${filePath}`);

		// Check if it's a config file change (needs tech stack re-scan)
		const configFiles = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile'];
		const isConfigChange = configFiles.some(f => filePath.endsWith(f));

		if (isConfigChange) {
			const root = this._getWorkspaceRoot();
			if (root) {
				const configResult = await this.configScanner.scan(root);
				this._dna.techStack = configResult.techStack;
			}
		}

		this._dna.lastIncrementalUpdate = new Date().toISOString();
		this._compressedSummary = compressDNA(this._dna);
	}

	private _buildTestingInfo(configResult: { techStack: TechStackEntry[] }): ProjectDNA['testing'] {
		const testFramework = configResult.techStack.find(t => t.category === 'testing');
		return {
			framework: testFramework?.name ?? '',
			testDirectory: '',
			namingConvention: testFramework?.name === 'pytest' ? 'test_*.py' : '*.test.ts',
			coveragePercent: 0,
			totalTests: 0,
		};
	}

	private _getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private async _saveToDisk(dna: ProjectDNA): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			return;
		}

		try {
			const uri = URI.joinPath(root, '.nyrve', 'project-dna.json');
			const content = JSON.stringify(dna, null, 2);
			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		} catch (error) {
			this.logService.error(`[Nyrve] Failed to save DNA: ${error}`);
		}
	}

	private async _loadFromDisk(): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			return;
		}

		try {
			const uri = URI.joinPath(root, '.nyrve', 'project-dna.json');
			const content = await this.fileService.readFile(uri);
			this._dna = JSON.parse(content.value.toString());
			if (this._dna) {
				this._compressedSummary = compressDNA(this._dna);
				this.logService.info(`[Nyrve] Loaded DNA from disk (last scan: ${this._dna.lastFullScan})`);
			}
		} catch {
			// File doesn't exist yet, that's fine
		}
	}

	private _emptyDNA(): ProjectDNA {
		return {
			projectName: '',
			description: '',
			primaryLanguage: 'unknown',
			languages: [],
			techStack: [],
			architecture: { type: 'unknown', entryPoints: [], moduleMap: [], dependencyGraph: [], layering: [] },
			patterns: [],
			conventions: [],
			testing: { framework: '', testDirectory: '', namingConvention: '', coveragePercent: 0, totalTests: 0 },
			git: { totalCommits: 0, activeContributors: 0, hotspots: [], couplings: [], churnRate: 0, branchStrategy: 'unknown' },
			complexity: { largestFiles: [], mostComplexFunctions: [], techDebt: [] },
			lastFullScan: '',
			lastIncrementalUpdate: '',
			scanDuration: 0,
		};
	}
}

registerSingleton(INyrveProjectDNA, NyrveProjectDNAService, InstantiationType.Delayed);
