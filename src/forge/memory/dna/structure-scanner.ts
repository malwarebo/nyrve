/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IForgeIndexManager } from '../../indexer/index-manager.js';

// --- Types ---

export interface ModuleInfo {
	readonly name: string;
	readonly path: string;
	readonly description: string;
	readonly fileCount: number;
	readonly symbolCount: number;
	readonly entryPoint?: string;
}

export interface DependencyEdge {
	readonly from: string;
	readonly to: string;
	readonly importCount: number;
}

export interface StructureScanResult {
	readonly architectureType: string;
	readonly entryPoints: string[];
	readonly modules: ModuleInfo[];
	readonly dependencyGraph: DependencyEdge[];
	readonly layering: string[];
}

// --- Scanner ---

export class ForgeStructureScanner {
	constructor(
		private readonly indexManager: IForgeIndexManager,
		private readonly logService: ILogService,
	) {}

	async scan(): Promise<StructureScanResult> {
		this.logService.info('[Forge] Structure scanner: analyzing codebase structure...');

		const stats = this.indexManager.getStats();
		if (stats.totalFiles === 0) {
			return {
				architectureType: 'unknown',
				entryPoints: [],
				modules: [],
				dependencyGraph: [],
				layering: [],
			};
		}

		// Detect entry points
		const entryPoints = this._detectEntryPoints();

		// Build module map from top-level directories
		const modules = this._buildModuleMap();

		// Detect architecture type
		const architectureType = this._detectArchitectureType(modules);

		// Build dependency graph (simplified — from index symbols)
		const dependencyGraph = this._buildDependencyGraph(modules);

		// Detect layering patterns
		const layering = this._detectLayering(dependencyGraph, modules);

		this.logService.info(
			`[Forge] Structure scanner: ${architectureType} architecture, ` +
			`${modules.length} modules, ${entryPoints.length} entry points`
		);

		return { architectureType, entryPoints, modules, dependencyGraph, layering };
	}

	private _detectEntryPoints(): string[] {
		const entryPointPatterns = [
			'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
			'src/index.ts', 'src/main.ts', 'src/app.ts',
			'src/index.js', 'src/main.js', 'src/app.js',
			'server.ts', 'server.js', 'src/server.ts',
			'main.py', 'app.py', 'manage.py',
			'main.go', 'cmd/main.go',
			'src/main.rs', 'src/lib.rs',
		];

		const found: string[] = [];
		for (const pattern of entryPointPatterns) {
			const results = this.indexManager.searchFiles(pattern);
			if (results.length > 0) {
				found.push(results[0]);
			}
		}
		return found;
	}

	private _buildModuleMap(): ModuleInfo[] {
		const modules: ModuleInfo[] = [];
		const dirCounts = new Map<string, { files: number; symbols: number }>();

		// Group files by their top-level src directory
		const allFiles = this.indexManager.searchFiles('');
		for (const filePath of allFiles) {
			const parts = filePath.split('/');
			// Find the module directory (first meaningful directory under src/)
			const srcIndex = parts.indexOf('src');
			const moduleIndex = srcIndex >= 0 ? srcIndex + 1 : 0;

			if (moduleIndex < parts.length - 1) {
				const modulePath = parts.slice(0, moduleIndex + 1).join('/');

				if (!dirCounts.has(modulePath)) {
					dirCounts.set(modulePath, { files: 0, symbols: 0 });
				}
				const entry = dirCounts.get(modulePath)!;
				entry.files++;

				const symbols = this.indexManager.getFileSymbols(filePath);
				entry.symbols += symbols.length;
			}
		}

		// Convert to ModuleInfo
		for (const [path, counts] of dirCounts) {
			const name = path.split('/').pop() ?? path;
			// Only include directories with multiple files
			if (counts.files >= 2) {
				modules.push({
					name,
					path,
					description: '', // Will be filled by pattern detector
					fileCount: counts.files,
					symbolCount: counts.symbols,
				});
			}
		}

		// Sort by file count descending
		modules.sort((a, b) => b.fileCount - a.fileCount);

		return modules.slice(0, 30); // Top 30 modules
	}

	private _detectArchitectureType(modules: ModuleInfo[]): string {
		const moduleNames = new Set(modules.map(m => m.name.toLowerCase()));

		// Check for monorepo patterns
		if (moduleNames.has('packages') || moduleNames.has('apps') || moduleNames.has('libs')) {
			return 'monorepo';
		}

		// Check for microservices patterns
		if (moduleNames.has('services') && modules.filter(m => m.name.includes('service')).length > 3) {
			return 'microservices';
		}

		// Check for layered architecture
		if (moduleNames.has('controllers') || moduleNames.has('routes') || moduleNames.has('models')) {
			return 'layered';
		}

		// Default
		return 'monolith';
	}

	private _buildDependencyGraph(modules: ModuleInfo[]): DependencyEdge[] {
		// Simplified: analyze file-level dependencies from the index
		// In a full implementation, we'd parse import statements
		const edges: DependencyEdge[] = [];
		const modulePaths = modules.map(m => m.path);

		// For now, detect dependencies based on naming conventions
		// A full implementation would use the import graph from the index
		for (let i = 0; i < modulePaths.length; i++) {
			for (let j = 0; j < modulePaths.length; j++) {
				if (i !== j) {
					// Check if any file in module i imports from module j
					const fromModule = modules[i];
					const toModule = modules[j];

					// Heuristic: common layering patterns
					if (this._isLikelyDependency(fromModule.name, toModule.name)) {
						edges.push({
							from: fromModule.path,
							to: toModule.path,
							importCount: 1,
						});
					}
				}
			}
		}

		return edges;
	}

	private _isLikelyDependency(from: string, to: string): boolean {
		const layeringRules: Array<[string, string]> = [
			['routes', 'controllers'],
			['controllers', 'services'],
			['services', 'repositories'],
			['repositories', 'models'],
			['handlers', 'services'],
			['api', 'services'],
			['ui', 'services'],
			['views', 'models'],
			['pages', 'components'],
			['components', 'hooks'],
		];

		for (const [f, t] of layeringRules) {
			if (from.toLowerCase().includes(f) && to.toLowerCase().includes(t)) {
				return true;
			}
		}
		return false;
	}

	private _detectLayering(graph: DependencyEdge[], modules: ModuleInfo[]): string[] {
		if (graph.length === 0) {
			return [];
		}

		// Build adjacency for topological ordering
		const inDegree = new Map<string, number>();
		const adj = new Map<string, string[]>();

		for (const m of modules) {
			inDegree.set(m.name, 0);
			adj.set(m.name, []);
		}

		for (const edge of graph) {
			const from = edge.from.split('/').pop() ?? '';
			const to = edge.to.split('/').pop() ?? '';
			adj.get(from)?.push(to);
			inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
		}

		// Topological sort for layering
		const layers: string[] = [];
		const queue: string[] = [];

		for (const [name, degree] of inDegree) {
			if (degree === 0) {
				queue.push(name);
			}
		}

		while (queue.length > 0) {
			const node = queue.shift()!;
			layers.push(node);
			for (const neighbor of adj.get(node) ?? []) {
				const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
				inDegree.set(neighbor, newDegree);
				if (newDegree === 0) {
					queue.push(neighbor);
				}
			}
		}

		if (layers.length > 1) {
			return [layers.join(' → ')];
		}
		return [];
	}
}
