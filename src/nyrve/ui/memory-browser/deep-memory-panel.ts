/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { INyrveProjectDNA, ProjectDNA } from '../../memory/project-dna.js';
import { INyrveDecisionJournal, DecisionEntry } from '../../memory/decision-journal.js';
import { INyrveTeamKnowledge, TeamKnowledgeSuggestion } from '../../memory/team-knowledge.js';
import { INyrveMemoryRetriever } from '../../memory/memory-retriever.js';

// --- Types ---

type TabId = 'dna' | 'decisions' | 'team' | 'stats';

// --- Deep Memory Browser ---

/**
 * Deep Memory Browser — four-tab panel for browsing the three-layer
 * memory system (Project DNA, Decisions, Team Knowledge) plus stats.
 */
export class NyrveDeepMemoryBrowser extends Disposable {

	private readonly _tabDisposables = this._register(new DisposableStore());
	private readonly _container: HTMLElement;
	private _activeTab: TabId = 'dna';

	constructor(
		parent: HTMLElement,
		private readonly projectDNA: INyrveProjectDNA,
		private readonly decisionJournal: INyrveDecisionJournal,
		private readonly teamKnowledge: INyrveTeamKnowledge,
		private readonly memoryRetriever: INyrveMemoryRetriever,
	) {
		super();

		this._container = document.createElement('div');
		this._container.className = 'nyrve-deep-memory-browser';
		parent.appendChild(this._container);

		this._register(this.projectDNA.onDidScanComplete(() => {
			if (this._activeTab === 'dna' || this._activeTab === 'stats') {
				this._renderActiveTab();
			}
		}));

		this._register(this.decisionJournal.onDidAddDecision(() => {
			if (this._activeTab === 'decisions' || this._activeTab === 'stats') {
				this._renderActiveTab();
			}
		}));

		this._render();
	}

	switchTab(tab: TabId): void {
		this._activeTab = tab;
		this._render();
	}

	private _render(): void {
		this._container.textContent = '';

		// Tab bar
		this._container.appendChild(this._renderTabBar());

		// Tab content
		const content = document.createElement('div');
		content.className = 'nyrve-deep-memory-content';
		this._container.appendChild(content);

		this._renderActiveTab();
	}

	private _renderActiveTab(): void {
		this._tabDisposables.clear();

		const content = this._container.querySelector('.nyrve-deep-memory-content');
		if (!content) {
			return;
		}
		content.textContent = '';

		switch (this._activeTab) {
			case 'dna':
				this._renderDNATab(content as HTMLElement);
				break;
			case 'decisions':
				this._renderDecisionsTab(content as HTMLElement);
				break;
			case 'team':
				this._renderTeamTab(content as HTMLElement);
				break;
			case 'stats':
				this._renderStatsTab(content as HTMLElement);
				break;
		}
	}

	private _renderTabBar(): HTMLElement {
		const tabBar = document.createElement('div');
		tabBar.className = 'nyrve-deep-memory-tabs';

		const tabs: Array<{ id: TabId; label: string }> = [
			{ id: 'dna', label: 'Project DNA' },
			{ id: 'decisions', label: 'Decisions' },
			{ id: 'team', label: 'Team Knowledge' },
			{ id: 'stats', label: 'Stats' },
		];

		for (const tab of tabs) {
			const btn = document.createElement('button');
			btn.className = `nyrve-deep-memory-tab${this._activeTab === tab.id ? ' active' : ''}`;
			btn.textContent = tab.label;
			btn.addEventListener('click', () => this.switchTab(tab.id));
			tabBar.appendChild(btn);
		}

		return tabBar;
	}

	// --- DNA Tab ---

	private _renderDNATab(container: HTMLElement): void {
		const dna = this.projectDNA.getDNA();

		if (!dna || !dna.lastFullScan) {
			const empty = document.createElement('div');
			empty.className = 'nyrve-deep-memory-empty';
			empty.innerHTML = '<p>No DNA scan has been run yet.</p>';

			const scanBtn = document.createElement('button');
			scanBtn.className = 'nyrve-deep-memory-action-btn';
			scanBtn.textContent = 'Run Full Scan';
			scanBtn.addEventListener('click', () => { this.projectDNA.fullScan(); });
			empty.appendChild(scanBtn);

			container.appendChild(empty);
			return;
		}

		container.appendChild(this._renderDNASection('Project', [
			`Name: ${dna.projectName}`,
			`Primary Language: ${dna.primaryLanguage}`,
			`Languages: ${dna.languages.map(l => `${l.language} (${l.percentage}%)`).join(', ')}`,
			`Last Scan: ${new Date(dna.lastFullScan).toLocaleString()}`,
			`Scan Duration: ${dna.scanDuration}ms`,
		]));

		container.appendChild(this._renderDNASection('Tech Stack', this._formatTechStack(dna)));
		container.appendChild(this._renderDNASection('Architecture', this._formatArchitecture(dna)));
		container.appendChild(this._renderDNASection('Patterns & Conventions', this._formatPatterns(dna)));
		container.appendChild(this._renderDNASection('Git Activity', this._formatGitActivity(dna)));
		container.appendChild(this._renderDNASection('Complexity', this._formatComplexity(dna)));

		// Rescan button
		const rescanBtn = document.createElement('button');
		rescanBtn.className = 'nyrve-deep-memory-action-btn';
		rescanBtn.textContent = 'Rescan Project';
		rescanBtn.addEventListener('click', () => { this.projectDNA.fullScan(); });
		container.appendChild(rescanBtn);
	}

	private _renderDNASection(title: string, lines: string[]): HTMLElement {
		const section = document.createElement('div');
		section.className = 'nyrve-deep-memory-section';

		const header = document.createElement('h3');
		header.textContent = title;
		section.appendChild(header);

		const list = document.createElement('ul');
		for (const line of lines) {
			const li = document.createElement('li');
			li.textContent = line;
			list.appendChild(li);
		}
		section.appendChild(list);

		return section;
	}

	private _formatTechStack(dna: ProjectDNA): string[] {
		if (dna.techStack.length === 0) {
			return ['No tech stack detected'];
		}
		return dna.techStack.map(t => `${t.name} ${t.version ?? ''} (${t.category})`);
	}

	private _formatArchitecture(dna: ProjectDNA): string[] {
		const lines = [`Type: ${dna.architecture.type}`];
		if (dna.architecture.entryPoints.length > 0) {
			lines.push(`Entry Points: ${dna.architecture.entryPoints.slice(0, 5).join(', ')}`);
		}
		lines.push(`Modules: ${dna.architecture.moduleMap.length}`);
		lines.push(`Dependencies: ${dna.architecture.dependencyGraph.length} edges`);
		if (dna.architecture.layering.length > 0) {
			lines.push(`Layers: ${dna.architecture.layering.join(' → ')}`);
		}
		return lines;
	}

	private _formatPatterns(dna: ProjectDNA): string[] {
		const lines: string[] = [];
		for (const p of dna.patterns.slice(0, 5)) {
			lines.push(`Pattern: ${p.name} — ${p.description}`);
		}
		for (const c of dna.conventions.slice(0, 5)) {
			lines.push(`Convention: ${c.name} — ${c.rule}`);
		}
		if (lines.length === 0) {
			lines.push('No patterns detected yet');
		}
		return lines;
	}

	private _formatGitActivity(dna: ProjectDNA): string[] {
		return [
			`Commits: ${dna.git.totalCommits}`,
			`Contributors: ${dna.git.activeContributors}`,
			`Churn: ${dna.git.churnRate} commits/week`,
			`Branch Strategy: ${dna.git.branchStrategy}`,
			`Hotspots: ${dna.git.hotspots.slice(0, 5).map(h => `${h.path} (${h.changeCount})`).join(', ') || 'none'}`,
		];
	}

	private _formatComplexity(dna: ProjectDNA): string[] {
		const lines: string[] = [];
		if (dna.complexity.largestFiles.length > 0) {
			lines.push(`Largest files: ${dna.complexity.largestFiles.slice(0, 3).map(f => `${f.path} (${f.lines} lines)`).join(', ')}`);
		}
		if (dna.complexity.techDebt.length > 0) {
			lines.push(`Tech debt items: ${dna.complexity.techDebt.length}`);
		}
		if (lines.length === 0) {
			lines.push('No complexity data');
		}
		return lines;
	}

	// --- Decisions Tab ---

	private async _renderDecisionsTab(container: HTMLElement): Promise<void> {
		const decisions = await this.decisionJournal.getAllDecisions();

		if (decisions.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'nyrve-deep-memory-empty';
			empty.textContent = 'No decisions recorded yet. Decisions are auto-extracted from conversations and commits.';
			container.appendChild(empty);
			return;
		}

		// Summary
		const summary = document.createElement('div');
		summary.className = 'nyrve-deep-memory-summary';
		const active = decisions.filter(d => d.status === 'active').length;
		const superseded = decisions.filter(d => d.status === 'superseded').length;
		summary.textContent = `${decisions.length} decisions (${active} active, ${superseded} superseded)`;
		container.appendChild(summary);

		// Decision list
		for (const decision of decisions.slice(0, 50)) {
			container.appendChild(this._renderDecisionEntry(decision));
		}
	}

	private _renderDecisionEntry(decision: DecisionEntry): HTMLElement {
		const row = document.createElement('div');
		row.className = `nyrve-deep-memory-decision ${decision.status}`;

		// Title + date
		const header = document.createElement('div');
		header.className = 'nyrve-decision-header';
		const title = document.createElement('strong');
		title.textContent = decision.title;
		header.appendChild(title);
		const date = document.createElement('span');
		date.className = 'nyrve-decision-date';
		date.textContent = ` (${decision.date.split('T')[0]})`;
		header.appendChild(date);
		row.appendChild(header);

		// Rationale
		if (decision.rationale) {
			const rationale = document.createElement('div');
			rationale.className = 'nyrve-decision-rationale';
			rationale.textContent = decision.rationale;
			row.appendChild(rationale);
		}

		// Tags + source
		const meta = document.createElement('div');
		meta.className = 'nyrve-decision-meta';
		const parts = [
			`Source: ${decision.source}`,
			decision.tags.length > 0 ? `Tags: ${decision.tags.join(', ')}` : '',
			decision.filesAffected.length > 0 ? `Files: ${decision.filesAffected.slice(0, 3).join(', ')}` : '',
		].filter(Boolean);
		meta.textContent = parts.join(' | ');
		row.appendChild(meta);

		// Status badge
		const badge = document.createElement('span');
		badge.className = `nyrve-decision-status nyrve-decision-status-${decision.status}`;
		badge.textContent = decision.status;
		row.appendChild(badge);

		return row;
	}

	// --- Team Knowledge Tab ---

	private async _renderTeamTab(container: HTMLElement): Promise<void> {
		const doc = await this.teamKnowledge.load();
		const suggestions = await this.teamKnowledge.getPendingSuggestions();

		// File info
		const fileInfo = document.createElement('div');
		fileInfo.className = 'nyrve-deep-memory-file-info';
		fileInfo.textContent = `File: ${this.teamKnowledge.getFilePath()}`;
		container.appendChild(fileInfo);

		// Pending suggestions
		if (suggestions.length > 0) {
			container.appendChild(this._renderSuggestionsSection(suggestions));
		}

		// Sections
		if (doc.sections.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'nyrve-deep-memory-empty';
			empty.textContent = 'Team knowledge file is empty or not yet created.';
			container.appendChild(empty);
			return;
		}

		for (const section of doc.sections) {
			const sectionEl = document.createElement('div');
			sectionEl.className = 'nyrve-deep-memory-section';

			const header = document.createElement('h3');
			header.textContent = section.title;
			sectionEl.appendChild(header);

			const list = document.createElement('ul');
			for (const entry of section.entries) {
				const li = document.createElement('li');
				li.textContent = entry.content;
				if (entry.addedDate) {
					const dateSpan = document.createElement('span');
					dateSpan.className = 'nyrve-team-entry-date';
					dateSpan.textContent = ` (${entry.addedDate})`;
					li.appendChild(dateSpan);
				}
				list.appendChild(li);
			}
			sectionEl.appendChild(list);

			container.appendChild(sectionEl);
		}
	}

	private _renderSuggestionsSection(suggestions: TeamKnowledgeSuggestion[]): HTMLElement {
		const section = document.createElement('div');
		section.className = 'nyrve-deep-memory-suggestions';

		const header = document.createElement('h3');
		header.textContent = `Pending Suggestions (${suggestions.length})`;
		section.appendChild(header);

		for (const sug of suggestions) {
			const row = document.createElement('div');
			row.className = 'nyrve-suggestion-row';

			const content = document.createElement('div');
			content.className = 'nyrve-suggestion-content';
			content.innerHTML = `<strong>${sug.section}:</strong> ${this._escapeHtml(sug.content)}`;
			row.appendChild(content);

			const reason = document.createElement('div');
			reason.className = 'nyrve-suggestion-reason';
			reason.textContent = `Reason: ${sug.reason}`;
			row.appendChild(reason);

			const actions = document.createElement('div');
			actions.className = 'nyrve-suggestion-actions';

			const approveBtn = document.createElement('button');
			approveBtn.className = 'nyrve-deep-memory-action-btn approve';
			approveBtn.textContent = 'Approve';
			approveBtn.addEventListener('click', async () => {
				await this.teamKnowledge.approveSuggestion(sug.id);
				this._renderActiveTab();
			});
			actions.appendChild(approveBtn);

			const rejectBtn = document.createElement('button');
			rejectBtn.className = 'nyrve-deep-memory-action-btn reject';
			rejectBtn.textContent = 'Reject';
			rejectBtn.addEventListener('click', async () => {
				await this.teamKnowledge.rejectSuggestion(sug.id);
				this._renderActiveTab();
			});
			actions.appendChild(rejectBtn);

			row.appendChild(actions);
			section.appendChild(row);
		}

		return section;
	}

	// --- Stats Tab ---

	private async _renderStatsTab(container: HTMLElement): Promise<void> {
		const dna = this.projectDNA.getDNA();
		const decisions = await this.decisionJournal.getAllDecisions();
		const doc = await this.teamKnowledge.load();

		// Retrieve a sample context to show token breakdown
		const memoryContext = await this.memoryRetriever.retrieve('', {});

		const stats: Array<{ label: string; value: string }> = [
			{ label: 'DNA Status', value: dna?.lastFullScan ? `Scanned ${new Date(dna.lastFullScan).toLocaleDateString()}` : 'Not scanned' },
			{ label: 'DNA Scan Duration', value: dna?.scanDuration ? `${dna.scanDuration}ms` : '-' },
			{ label: 'Total Decisions', value: String(decisions.length) },
			{ label: 'Active Decisions', value: String(decisions.filter(d => d.status === 'active').length) },
			{ label: 'Team Knowledge Sections', value: String(doc.sections.length) },
			{ label: 'Team Knowledge Entries', value: String(doc.sections.reduce((sum, s) => sum + s.entries.length, 0)) },
			{ label: 'Memory Token Budget', value: `${memoryContext.totalTokens} / ${this._getMaxTokens()} tokens` },
			{ label: 'Token Breakdown', value: `Team: ${memoryContext.layerBreakdown.team}, DNA: ${memoryContext.layerBreakdown.dna}, Decisions: ${memoryContext.layerBreakdown.decisions}` },
			{ label: 'Retrieval Time', value: `${memoryContext.retrievalTime}ms` },
		];

		const table = document.createElement('table');
		table.className = 'nyrve-deep-memory-stats-table';

		for (const stat of stats) {
			const tr = document.createElement('tr');
			const labelTd = document.createElement('td');
			labelTd.className = 'nyrve-stat-label';
			labelTd.textContent = stat.label;
			tr.appendChild(labelTd);
			const valueTd = document.createElement('td');
			valueTd.className = 'nyrve-stat-value';
			valueTd.textContent = stat.value;
			tr.appendChild(valueTd);
			table.appendChild(tr);
		}

		container.appendChild(table);

		// Compressed summary preview
		const summarySection = document.createElement('div');
		summarySection.className = 'nyrve-deep-memory-section';
		const summaryHeader = document.createElement('h3');
		summaryHeader.textContent = 'Compressed DNA Summary (sent to agent)';
		summarySection.appendChild(summaryHeader);

		const summaryPre = document.createElement('pre');
		summaryPre.className = 'nyrve-deep-memory-summary-preview';
		summaryPre.textContent = this.projectDNA.getCompressedSummary() || '(no summary — run a DNA scan first)';
		summarySection.appendChild(summaryPre);
		container.appendChild(summarySection);
	}

	private _getMaxTokens(): number {
		return 3000; // Default; in full implementation, read from config
	}

	private _escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}
}
