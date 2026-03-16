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

// --- Types ---

export interface TeamKnowledgeSuggestion {
	readonly id: string;
	readonly section: string;
	readonly content: string;
	readonly reason: string;
	readonly source: 'agent_detected' | 'decision_journal';
	readonly createdAt: string;
}

export interface TeamKnowledgeDoc {
	readonly sections: Array<{
		title: string;
		entries: Array<{
			content: string;
			addedDate?: string;
			addedBy?: string;
		}>;
	}>;
}

// --- Service Interface ---

export const INyrveTeamKnowledge = createDecorator<INyrveTeamKnowledge>('nyrveTeamKnowledge');

export interface INyrveTeamKnowledge {
	readonly _serviceBrand: undefined;

	/** Fires when a new suggestion is created. */
	readonly onDidAddSuggestion: Event<TeamKnowledgeSuggestion>;

	/** Load and parse the team knowledge file. */
	load(): Promise<TeamKnowledgeDoc>;

	/** Suggest an addition (agent proposes, human approves). */
	suggestAddition(section: string, content: string, reason: string, source?: TeamKnowledgeSuggestion['source']): Promise<void>;

	/** Get pending suggestions. */
	getPendingSuggestions(): Promise<TeamKnowledgeSuggestion[]>;

	/** Approve a suggestion (appends to the team knowledge file). */
	approveSuggestion(id: string): Promise<void>;

	/** Reject a suggestion. */
	rejectSuggestion(id: string): Promise<void>;

	/** Parse the team knowledge file for agent context. */
	getContextBlock(): Promise<string>;

	/** Get the file path for the team knowledge file. */
	getFilePath(): string;
}

// --- Starter Template ---

const STARTER_TEMPLATE = `# Team Knowledge

## Architecture
- (Add architecture notes here)

## Conventions
- (Add coding conventions here)

## Why We Made These Choices
- (Add decision rationale here)

## Known Gotchas
- (Add non-obvious issues and workarounds here)

## Onboarding
- (Add setup instructions here)
`;

// --- Service Implementation ---

export class NyrveTeamKnowledgeService extends Disposable implements INyrveTeamKnowledge {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAddSuggestion = this._register(new Emitter<TeamKnowledgeSuggestion>());
	readonly onDidAddSuggestion: Event<TeamKnowledgeSuggestion> = this._onDidAddSuggestion.event;

	private _suggestions: TeamKnowledgeSuggestion[] = [];
	private _suggestionsLoaded = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getFilePath(): string {
		return this.configurationService.getValue<string>('nyrve.memory.team.filePath') ?? '.nyrve/team-knowledge.md';
	}

	async load(): Promise<TeamKnowledgeDoc> {
		const content = await this._readFile();
		if (!content) {
			return { sections: [] };
		}
		return this._parseMarkdown(content);
	}

	async suggestAddition(
		section: string,
		content: string,
		reason: string,
		source: TeamKnowledgeSuggestion['source'] = 'agent_detected',
	): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('nyrve.memory.team.suggestAdditions') ?? true;
		if (!enabled) {
			return;
		}

		await this._loadSuggestions();

		const suggestion: TeamKnowledgeSuggestion = {
			id: `sug_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			section,
			content,
			reason,
			source,
			createdAt: new Date().toISOString(),
		};

		this._suggestions.push(suggestion);
		await this._saveSuggestions();
		this._onDidAddSuggestion.fire(suggestion);

		this.logService.info(`[Nyrve] Team knowledge suggestion: "${content.slice(0, 50)}..." for section "${section}"`);
	}

	async getPendingSuggestions(): Promise<TeamKnowledgeSuggestion[]> {
		await this._loadSuggestions();
		return [...this._suggestions];
	}

	async approveSuggestion(id: string): Promise<void> {
		await this._loadSuggestions();
		const suggestion = this._suggestions.find(s => s.id === id);
		if (!suggestion) {
			return;
		}

		// Append to the team knowledge file
		let fileContent = await this._readFile();
		if (!fileContent) {
			// Create with starter template
			fileContent = STARTER_TEMPLATE;
		}

		// Find the section and append
		const sectionHeader = `## ${suggestion.section}`;
		const sectionIndex = fileContent.indexOf(sectionHeader);

		if (sectionIndex >= 0) {
			// Find the end of the section (next ## or end of file)
			const afterSection = fileContent.indexOf('\n## ', sectionIndex + sectionHeader.length);
			const insertPoint = afterSection >= 0 ? afterSection : fileContent.length;

			// Insert the new entry before the next section
			const newEntry = `\n- ${suggestion.content}`;
			fileContent = fileContent.slice(0, insertPoint) + newEntry + fileContent.slice(insertPoint);
		} else {
			// Section doesn't exist — append it
			fileContent += `\n\n## ${suggestion.section}\n- ${suggestion.content}\n`;
		}

		await this._writeFile(fileContent);

		// Remove the approved suggestion
		this._suggestions = this._suggestions.filter(s => s.id !== id);
		await this._saveSuggestions();

		this.logService.info(`[Nyrve] Team knowledge suggestion approved: "${suggestion.content.slice(0, 50)}..."`);
	}

	async rejectSuggestion(id: string): Promise<void> {
		await this._loadSuggestions();
		this._suggestions = this._suggestions.filter(s => s.id !== id);
		await this._saveSuggestions();
	}

	async getContextBlock(): Promise<string> {
		const content = await this._readFile();
		if (!content) {
			return '';
		}
		return `## Team Knowledge (shared, from ${this.getFilePath()})\n${content}`;
	}

	// --- Private ---

	private _parseMarkdown(content: string): TeamKnowledgeDoc {
		const sections: TeamKnowledgeDoc['sections'] = [];
		let currentSection: { title: string; entries: Array<{ content: string; addedDate?: string; addedBy?: string }> } | undefined;

		for (const line of content.split('\n')) {
			if (line.startsWith('## ')) {
				if (currentSection) {
					sections.push(currentSection);
				}
				currentSection = { title: line.slice(3).trim(), entries: [] };
			} else if (currentSection && line.startsWith('- ')) {
				const entryContent = line.slice(2).trim();
				// Try to extract date from parenthetical at end: "... (2026-01-20)"
				const dateMatch = entryContent.match(/\((\d{4}-\d{2}-\d{2})\)\s*$/);
				currentSection.entries.push({
					content: dateMatch ? entryContent.replace(dateMatch[0], '').trim() : entryContent,
					addedDate: dateMatch?.[1],
				});
			}
		}

		if (currentSection) {
			sections.push(currentSection);
		}

		return { sections };
	}

	private async _readFile(): Promise<string | null> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			return null;
		}

		try {
			const uri = URI.joinPath(root, this.getFilePath());
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return null;
		}
	}

	private async _writeFile(content: string): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			return;
		}

		try {
			const uri = URI.joinPath(root, this.getFilePath());
			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		} catch (error) {
			this.logService.error(`[Nyrve] Failed to write team knowledge: ${error}`);
		}
	}

	private async _loadSuggestions(): Promise<void> {
		if (this._suggestionsLoaded) {
			return;
		}

		const root = this._getWorkspaceRoot();
		if (!root) {
			this._suggestionsLoaded = true;
			return;
		}

		try {
			const uri = URI.joinPath(root, '.nyrve', 'pending-suggestions.json');
			const content = await this.fileService.readFile(uri);
			this._suggestions = JSON.parse(content.value.toString());
		} catch {
			this._suggestions = [];
		}
		this._suggestionsLoaded = true;
	}

	private async _saveSuggestions(): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			return;
		}

		try {
			const uri = URI.joinPath(root, '.nyrve', 'pending-suggestions.json');
			const content = JSON.stringify(this._suggestions, null, 2);
			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		} catch (error) {
			this.logService.error(`[Nyrve] Failed to save suggestions: ${error}`);
		}
	}

	private _getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}
}

registerSingleton(INyrveTeamKnowledge, NyrveTeamKnowledgeService, InstantiationType.Delayed);
