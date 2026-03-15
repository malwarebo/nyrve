/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compresses a full ProjectDNA into a ~1-2K token summary suitable for agent system prompts.
 */

import type { ProjectDNA } from '../project-dna.js';

export function compressDNA(dna: ProjectDNA): string {
	const parts: string[] = [];

	// Project identity
	parts.push(`## Project: ${dna.projectName || 'Unknown'}`);

	// Tech stack (one line)
	const stackLine = dna.techStack
		.filter(t => ['framework', 'language', 'database', 'orm'].includes(t.category))
		.map(t => t.version ? `${t.name} ${t.version}` : t.name)
		.join(' + ');
	if (stackLine) {
		parts.push(stackLine);
	}

	// Architecture
	parts.push('');
	parts.push('## Architecture');
	parts.push(`${dna.architecture.type}. Entry: ${dna.architecture.entryPoints.slice(0, 3).join(', ') || 'unknown'}.`);

	if (dna.architecture.layering.length > 0) {
		parts.push(`Layers: ${dna.architecture.layering[0]}.`);
	}

	if (dna.architecture.moduleMap.length > 0) {
		const moduleList = dna.architecture.moduleMap
			.slice(0, 8)
			.map(m => `${m.name} (${m.path})${m.description ? ' ' + m.description : ''}`)
			.join(', ');
		parts.push(`Modules: ${moduleList}.`);
	}

	// Patterns
	if (dna.patterns.length > 0) {
		parts.push('');
		parts.push('## Patterns');
		for (const p of dna.patterns.slice(0, 6)) {
			parts.push(`- ${p.name}: ${p.description} (${p.frequency} files, ${(p.confidence * 100).toFixed(0)}% confidence)`);
		}
	}

	// Conventions
	if (dna.conventions.length > 0) {
		parts.push('');
		parts.push('## Conventions');
		for (const c of dna.conventions.slice(0, 8)) {
			parts.push(`- ${c.rule} (from ${c.detectedFrom})`);
		}
	}

	// Testing
	if (dna.testing.framework) {
		parts.push('');
		parts.push('## Testing');
		parts.push(`${dna.testing.framework}. ${dna.testing.totalTests} tests. ${dna.testing.coveragePercent}% coverage. Convention: ${dna.testing.namingConvention}`);
	}

	// Hotspots (condensed)
	if (dna.git.hotspots.length > 0) {
		parts.push('');
		parts.push('## Hotspots (last 90 days)');
		const hotspotLine = dna.git.hotspots
			.slice(0, 5)
			.map(h => `${h.path} (${h.changeCount} changes)`)
			.join(', ');
		parts.push(hotspotLine);
	}

	const result = parts.join('\n');

	// Ensure we stay under ~2K tokens (~8000 chars)
	if (result.length > 8000) {
		return result.slice(0, 7900) + '\n... [truncated]';
	}

	return result;
}
