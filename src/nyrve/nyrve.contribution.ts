/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../vs/nls.js';
import { Registry } from '../vs/platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../vs/platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../vs/workbench/common/contributions.js';
import { Action2, registerAction2 } from '../vs/platform/actions/common/actions.js';
import { KeybindingWeight } from '../vs/platform/keybinding/common/keybindingsRegistry.js';
import { KeyMod, KeyCode } from '../vs/base/common/keyCodes.js';
import type { ServicesAccessor } from '../vs/platform/instantiation/common/instantiation.js';
import { INyrveDiffService } from './ui/diff-review/diff-panel.js';
import { INyrvePlanPanel } from './ui/plan/plan-panel.js';

// --- Nyrve Native AI Removal (runtime deregistration of chat UI) ---
// Native chat services remain loaded (required by tasks, debug, notebooks, MCP).
// This contribution hides the Chat/Copilot UI at runtime by replacing commands with no-ops.
import './core/nyrve-disable-native-ai.js';

// --- Nyrve Service Registration (side-effect imports trigger registerSingleton) ---
import './core/config.js';
import './agent/token-tracker.js';
import './agent/model-router.js';
import './agent/agent-engine.js';
import './agent/agent-service.js';
import './agent/confirmation.js';
import './agent/action-executor.js';
import './context/editor-bridge.js';
import './context/mention-registry.js';
import './context/mention-resolver.js';
import './context/context-builder.js';
import './indexer/nyrveignore.js';
import './indexer/symbol-extractor.js';
import './indexer/index-manager.js';
import './ui/diff-review/hunk-controls.js';
import './ui/diff-review/change-decorations.js';
import './agent/verification/framework-detector.js';
import './agent/verification/type-checker.js';
import './agent/verification/test-runner.js';
import './agent/verification/coverage-checker.js';
import './agent/verification/import-checker.js';
import './agent/verification/self-healer.js';
import './agent/verification-engine.js';
import './agent/background-agent.js';
import './memory/memory-engine.js';
import './memory/memory-extractor.js';
import './memory/memory-decay.js';
import './memory/shared-memory.js';

// --- Nyrve Deep Memory (v2: Three-Layer Memory System) ---
import './memory/project-dna.js';
import './memory/decision-journal.js';
import './memory/decision-extractor.js';
import './memory/team-knowledge.js';
import './memory/memory-retriever.js';
import './github/auth.js';
import './github/github-service.js';
import './github/pr-manager.js';
import './github/issue-manager.js';
import './github/review-handler.js';
import './github/ci-monitor.js';
import './ui/task-queue/task-panel.js';
import './ui/task-queue/progress-tracker.js';
import './api/extension-api.js';
import './ui/suggestions/gutter-indicators.js';
import './core/api-client.js';
import './core/auth-service.js';
import './core/settings-service.js';
import './core/storage.js';
import './core/encryption.js';
import './core/telemetry.js';
import './core/updater.js';

// --- Nyrve Vision (v3: Phase 10) ---
import './vision/image-input.js';
import './vision/image-processor.js';
import './vision/vision-api.js';
import './vision/vision-attachment-ui.js';
import './vision/vision-plan-integration.js';

// --- Nyrve Plan Mode (v3: Phase 9) ---
import './plan/plan-types.js';
import './plan/plan-generator.js';
import './plan/plan-executor.js';

// --- Nyrve Inline Completions (v3: Phase 8) ---
import './completions/completion-trigger.js';
import './completions/completion-context.js';
import './completions/completion-cache.js';
import './completions/completion-engine.js';
import './completions/completion-postprocessor.js';
import './completions/ghost-text-renderer.js';
import './completions/completion-keybindings.js';
import './completions/completion-stats.js';

// --- Nyrve Verification UI ---
import './ui/verification/verification-panel.js';

// --- Nyrve UI Registration ---
import './ui/agent-panel/agent-panel.js';
import './ui/welcome/welcome-page.js';
import './ui/settings/settings-page.js';

// --- Nyrve Status Bar ---
import { NyrveStatusBarContribution } from './ui/status-bar/nyrve-status.js';
registerWorkbenchContribution2('nyrve.statusBar', NyrveStatusBarContribution, WorkbenchPhase.AfterRestored);

// --- Nyrve Diff Review Keybindings ---

const NYRVE_DIFF_CATEGORY = localize2('nyrve.diff.category', "Nyrve Diff Review");

registerAction2(class AcceptHunkAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.diff.acceptHunk',
			title: localize2('nyrve.diff.acceptHunk', "Accept Current Hunk"),
			category: NYRVE_DIFF_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const diffService = accessor.get(INyrveDiffService);
		const changeSet = diffService.getActiveChangeSet();
		if (!changeSet) {
			return;
		}
		const pendingHunks = diffService.getHunks(changeSet.id).filter(h => h.status === 'pending');
		if (pendingHunks.length > 0) {
			await diffService.acceptHunk(changeSet.id, pendingHunks[0].id);
		}
	}
});

registerAction2(class RejectHunkAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.diff.rejectHunk',
			title: localize2('nyrve.diff.rejectHunk', "Reject Current Hunk"),
			category: NYRVE_DIFF_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const diffService = accessor.get(INyrveDiffService);
		const changeSet = diffService.getActiveChangeSet();
		if (!changeSet) {
			return;
		}
		const pendingHunks = diffService.getHunks(changeSet.id).filter(h => h.status === 'pending');
		if (pendingHunks.length > 0) {
			diffService.rejectHunk(changeSet.id, pendingHunks[0].id);
		}
	}
});

registerAction2(class AcceptAllHunksAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.diff.acceptAll',
			title: localize2('nyrve.diff.acceptAll', "Accept All Changes"),
			category: NYRVE_DIFF_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const diffService = accessor.get(INyrveDiffService);
		const changeSet = diffService.getActiveChangeSet();
		if (changeSet) {
			await diffService.acceptAll(changeSet.id);
		}
	}
});

// --- Nyrve Plan Mode Keybindings ---

const NYRVE_PLAN_CATEGORY = localize2('nyrve.plan.category', "Nyrve Plan Mode");

registerAction2(class StartPlanModeAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.plan.start',
			title: localize2('nyrve.plan.start', "Start Plan Mode"),
			category: NYRVE_PLAN_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(INyrvePlanPanel);
		planPanel.activate();
	}
});

registerAction2(class CancelPlanAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.plan.cancel',
			title: localize2('nyrve.plan.cancel', "Cancel Plan"),
			category: NYRVE_PLAN_CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(INyrvePlanPanel);
		planPanel.cancelPlan();
	}
});

registerAction2(class PausePlanAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.plan.pause',
			title: localize2('nyrve.plan.pause', "Pause Plan Execution"),
			category: NYRVE_PLAN_CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(INyrvePlanPanel);
		planPanel.pauseExecution();
	}
});

registerAction2(class ResumePlanAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.plan.resume',
			title: localize2('nyrve.plan.resume', "Resume Plan Execution"),
			category: NYRVE_PLAN_CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(INyrvePlanPanel);
		planPanel.resumeExecution();
	}
});

// --- Nyrve Configuration Registration ---

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

// Agent settings
configurationRegistry.registerConfiguration({
	id: 'nyrve',
	title: localize('nyrveConfigurationTitle', "Nyrve"),
	order: 200,
	type: 'object',
	properties: {
		'nyrve.agent.confirmationLevel': {
			type: 'string',
			enum: ['cautious', 'balanced', 'autonomous'],
			enumDescriptions: [
				localize('nyrve.agent.confirmationLevel.cautious', "Ask for confirmation before every agent action."),
				localize('nyrve.agent.confirmationLevel.balanced', "Ask for confirmation for file writes and commands, auto-approve reads."),
				localize('nyrve.agent.confirmationLevel.autonomous', "Agent acts without confirmation (use with caution)."),
			],
			default: 'balanced',
			description: localize('nyrve.agent.confirmationLevel', "Controls how much confirmation the agent requires before taking actions."),
		},
		'nyrve.agent.defaultModel': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
			default: 'claude-sonnet',
			description: localize('nyrve.agent.defaultModel', "The default Claude model used for interactive agent chat."),
		},
		'nyrve.agent.complexTaskModel': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
			default: 'claude-opus',
			description: localize('nyrve.agent.complexTaskModel', "The Claude model used for complex multi-file tasks and planning."),
		},
		'nyrve.agent.backgroundModel': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
			default: 'claude-haiku',
			description: localize('nyrve.agent.backgroundModel', "The Claude model used for background agent suggestions."),
		},
		'nyrve.agent.modelSwitcher': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.agent.modelSwitcher', "Show model selector in the Agent Panel UI."),
		},
		'nyrve.agent.maxTokensPerRequest': {
			type: 'number',
			default: 100000,
			minimum: 1000,
			maximum: 200000,
			description: localize('nyrve.agent.maxTokensPerRequest', "Maximum tokens per agent API request."),
		},
		'nyrve.agent.streamResponses': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.agent.streamResponses', "Stream agent responses token by token."),
		},
	}
});

// Background agent settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.backgroundAgent',
	title: localize('nyrveBackgroundAgentTitle', "Nyrve Background Agent"),
	order: 201,
	type: 'object',
	properties: {
		'nyrve.backgroundAgent.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.backgroundAgent.enabled', "Enable the background agent that passively monitors your code."),
		},
		'nyrve.backgroundAgent.mode': {
			type: 'string',
			enum: ['active', 'on-save', 'on-commit', 'off'],
			enumDescriptions: [
				localize('nyrve.backgroundAgent.mode.active', "Monitor and suggest in real-time."),
				localize('nyrve.backgroundAgent.mode.onSave', "Only analyze on file save."),
				localize('nyrve.backgroundAgent.mode.onCommit', "Only analyze staged changes before commit."),
				localize('nyrve.backgroundAgent.mode.off', "Disabled."),
			],
			default: 'on-save',
			description: localize('nyrve.backgroundAgent.mode', "Controls when the background agent analyzes your code."),
		},
		'nyrve.backgroundAgent.minSeverity': {
			type: 'string',
			enum: ['info', 'warning', 'critical'],
			default: 'warning',
			description: localize('nyrve.backgroundAgent.minSeverity', "Minimum severity level for background agent suggestions."),
		},
		'nyrve.backgroundAgent.dailyTokenBudget': {
			type: 'number',
			default: 500000,
			minimum: 0,
			description: localize('nyrve.backgroundAgent.dailyTokenBudget', "Maximum daily token spend for background analysis."),
		},
	}
});

// Indexer settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.indexer',
	title: localize('nyrveIndexerTitle', "Nyrve Indexer"),
	order: 202,
	type: 'object',
	properties: {
		'nyrve.indexer.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.indexer.enabled', "Enable the codebase indexer for semantic search and context retrieval."),
		},
		'nyrve.indexer.maxFileSize': {
			type: 'number',
			default: 1048576,
			description: localize('nyrve.indexer.maxFileSize', "Maximum file size in bytes to index."),
		},
		'nyrve.indexer.maxProjectFiles': {
			type: 'number',
			default: 50000,
			description: localize('nyrve.indexer.maxProjectFiles', "Maximum number of files to index per project."),
		},
	}
});

// Context settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.context',
	title: localize('nyrveContextTitle', "Nyrve Context"),
	order: 203,
	type: 'object',
	properties: {
		'nyrve.context.defaultTokenBudget': {
			type: 'number',
			default: 30000,
			minimum: 1000,
			description: localize('nyrve.context.defaultTokenBudget', "Default token budget for agent context."),
		},
	}
});

// Diff review settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.diff',
	title: localize('nyrveDiffTitle', "Nyrve Diff Review"),
	order: 204,
	type: 'object',
	properties: {
		'nyrve.diff.autoOpenOnChange': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.diff.autoOpenOnChange', "Automatically open the diff review panel when the agent proposes changes."),
		},
		'nyrve.diff.showGutterDecorations': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.diff.showGutterDecorations', "Show gutter decorations on lines modified by the agent."),
		},
		'nyrve.diff.highlightDuration': {
			type: 'number',
			default: 30,
			minimum: 0,
			description: localize('nyrve.diff.highlightDuration', "Duration in seconds to highlight agent-modified lines after acceptance."),
		},
	}
});

// Memory settings (v2: Deep Project Memory)
configurationRegistry.registerConfiguration({
	id: 'nyrve.memory',
	title: localize('nyrveMemoryTitle', "Nyrve Memory"),
	order: 205,
	type: 'object',
	properties: {
		'nyrve.memory.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.enabled', "Enable session memory for the agent."),
		},
		'nyrve.memory.maxEntries': {
			type: 'number',
			default: 1000,
			minimum: 100,
			description: localize('nyrve.memory.maxEntries', "Maximum memory entries per project."),
		},
		'nyrve.memory.decayDays': {
			type: 'number',
			default: 90,
			minimum: 7,
			description: localize('nyrve.memory.decayDays', "Days of inactivity before memory confidence begins to decay."),
		},
		'nyrve.memory.autoExtract': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.autoExtract', "Automatically extract memories from conversations."),
		},
		'nyrve.memory.deepMemoryEnabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.deepMemoryEnabled', "Enable the three-layer deep project memory system."),
		},
		// Layer 1: Project DNA
		'nyrve.memory.dna.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.dna.enabled', "Enable automatic project DNA scanning."),
		},
		'nyrve.memory.dna.autoScan': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.dna.autoScan', "Automatically scan project when opened."),
		},
		'nyrve.memory.dna.scanOnOpen': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.dna.scanOnOpen', "Run DNA scan on project open."),
		},
		'nyrve.memory.dna.incrementalUpdates': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.dna.incrementalUpdates', "Update DNA incrementally on file save."),
		},
		'nyrve.memory.dna.gitHistoryDays': {
			type: 'number',
			default: 90,
			minimum: 30,
			maximum: 365,
			description: localize('nyrve.memory.dna.gitHistoryDays', "Number of days of git history to analyze for hotspots."),
		},
		'nyrve.memory.dna.patternDetectionModel': {
			type: 'string',
			enum: ['claude-haiku', 'claude-sonnet'],
			default: 'claude-haiku',
			description: localize('nyrve.memory.dna.patternDetectionModel', "Claude model to use for pattern detection."),
		},
		// Layer 2: Decision Journal
		'nyrve.memory.decisions.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.decisions.enabled', "Enable the decision journal."),
		},
		'nyrve.memory.decisions.autoExtract': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.decisions.autoExtract', "Auto-extract decisions from conversations."),
		},
		'nyrve.memory.decisions.extractFromCommits': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.decisions.extractFromCommits', "Auto-extract decisions from git commits."),
		},
		'nyrve.memory.decisions.extractionModel': {
			type: 'string',
			enum: ['claude-haiku', 'claude-sonnet'],
			default: 'claude-haiku',
			description: localize('nyrve.memory.decisions.extractionModel', "Claude model to use for decision extraction."),
		},
		'nyrve.memory.decisions.maxEntries': {
			type: 'number',
			default: 500,
			minimum: 50,
			maximum: 2000,
			description: localize('nyrve.memory.decisions.maxEntries', "Maximum decision journal entries."),
		},
		// Layer 3: Team Knowledge
		'nyrve.memory.team.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.team.enabled', "Enable team knowledge file management."),
		},
		'nyrve.memory.team.filePath': {
			type: 'string',
			default: '.nyrve/team-knowledge.md',
			description: localize('nyrve.memory.team.filePath', "Path to the team knowledge file."),
		},
		'nyrve.memory.team.suggestAdditions': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.team.suggestAdditions', "Agent suggests additions to team knowledge."),
		},
		// Retrieval
		'nyrve.memory.retrieval.maxTokens': {
			type: 'number',
			default: 3000,
			minimum: 1000,
			maximum: 6000,
			description: localize('nyrve.memory.retrieval.maxTokens', "Maximum tokens for memory context per agent request."),
		},
		'nyrve.memory.retrieval.includeAllLayers': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.memory.retrieval.includeAllLayers', "Include all three memory layers in agent context."),
		},
	}
});

// GitHub settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.github',
	title: localize('nyrveGitHubTitle', "Nyrve GitHub"),
	order: 206,
	type: 'object',
	properties: {
		'nyrve.github.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.github.enabled', "Enable GitHub integration features."),
		},
		'nyrve.github.autoLinkIssues': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.github.autoLinkIssues', "Automatically link mentioned issue numbers to GitHub issues."),
		},
		'nyrve.github.ciMonitoring': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.github.ciMonitoring', "Monitor GitHub Actions workflow status after pushing."),
		},
	}
});

// Task queue settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.tasks',
	title: localize('nyrveTasksTitle', "Nyrve Task Queue"),
	order: 207,
	type: 'object',
	properties: {
		'nyrve.tasks.maxConcurrent': {
			type: 'number',
			default: 1,
			minimum: 1,
			maximum: 5,
			description: localize('nyrve.tasks.maxConcurrent', "Maximum number of concurrent agent tasks."),
		},
		'nyrve.tasks.dailyTokenBudget': {
			type: 'number',
			default: 1000000,
			minimum: 0,
			description: localize('nyrve.tasks.dailyTokenBudget', "Maximum daily token spend for task queue execution."),
		},
		'nyrve.tasks.persistQueue': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.tasks.persistQueue', "Persist the task queue across editor restarts."),
		},
	}
});

// Verification settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.verification',
	title: localize('nyrveVerificationTitle', "Nyrve Verification"),
	order: 209,
	type: 'object',
	properties: {
		'nyrve.verification.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.verification.enabled', "Verify agent changes before showing diffs."),
		},
		'nyrve.verification.runTypeCheck': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.verification.runTypeCheck', "Run the project type checker as part of verification."),
		},
		'nyrve.verification.runTests': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.verification.runTests', "Run relevant tests as part of verification."),
		},
		'nyrve.verification.runCoverage': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.verification.runCoverage', "Check test coverage of agent-changed lines."),
		},
		'nyrve.verification.runImportCheck': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.verification.runImportCheck', "Check imports for broken paths and circular dependencies."),
		},
		'nyrve.verification.coverageThreshold': {
			type: 'number',
			default: 70,
			minimum: 0,
			maximum: 100,
			description: localize('nyrve.verification.coverageThreshold', "Minimum coverage percentage for changed lines."),
		},
		'nyrve.verification.maxSelfHealAttempts': {
			type: 'number',
			default: 3,
			minimum: 1,
			maximum: 5,
			description: localize('nyrve.verification.maxSelfHealAttempts', "Maximum self-heal attempts when verification fails."),
		},
		'nyrve.verification.selfHealTimeout': {
			type: 'number',
			default: 120000,
			minimum: 30000,
			maximum: 300000,
			description: localize('nyrve.verification.selfHealTimeout', "Total timeout in ms for the self-heal loop."),
		},
		'nyrve.verification.testTimeout': {
			type: 'number',
			default: 60000,
			minimum: 15000,
			maximum: 300000,
			description: localize('nyrve.verification.testTimeout', "Maximum time in ms for a single test run."),
		},
		'nyrve.verification.addCommitFooter': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.verification.addCommitFooter', "Add verification footer to agent-created commits."),
		},
		'nyrve.verification.testCommand': {
			type: 'string',
			default: '',
			description: localize('nyrve.verification.testCommand', "Override auto-detected test command (empty = auto-detect)."),
		},
		'nyrve.verification.typeCheckCommand': {
			type: 'string',
			default: '',
			description: localize('nyrve.verification.typeCheckCommand', "Override auto-detected type check command (empty = auto-detect)."),
		},
		'nyrve.verification.coverageCommand': {
			type: 'string',
			default: '',
			description: localize('nyrve.verification.coverageCommand', "Override auto-detected coverage command (empty = auto-detect)."),
		},
	}
});

// Inline completions settings (v3)
configurationRegistry.registerConfiguration({
	id: 'nyrve.completions',
	title: localize('nyrveCompletionsTitle', "Nyrve Inline Completions"),
	order: 210,
	type: 'object',
	properties: {
		'nyrve.completions.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.completions.enabled', "Enable AI-powered inline code completions."),
		},
		'nyrve.completions.model': {
			type: 'string',
			enum: ['claude-haiku', 'claude-sonnet'],
			default: 'claude-haiku',
			description: localize('nyrve.completions.model', "Claude model for inline completions (Haiku for speed, Sonnet for quality)."),
		},
		'nyrve.completions.triggerDelay': {
			type: 'number',
			default: 150,
			minimum: 50,
			maximum: 1000,
			description: localize('nyrve.completions.triggerDelay', "Delay in milliseconds before triggering a completion after typing."),
		},
		'nyrve.completions.maxLines': {
			type: 'number',
			default: 15,
			minimum: 1,
			maximum: 50,
			description: localize('nyrve.completions.maxLines', "Maximum lines in a single inline completion."),
		},
		'nyrve.completions.cacheTTL': {
			type: 'number',
			default: 30,
			minimum: 5,
			maximum: 300,
			description: localize('nyrve.completions.cacheTTL', "Cache time-to-live in seconds for completion results."),
		},
		'nyrve.completions.cacheSize': {
			type: 'number',
			default: 100,
			minimum: 10,
			maximum: 1000,
			description: localize('nyrve.completions.cacheSize', "Maximum number of completions to cache."),
		},
		'nyrve.completions.useProjectContext': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.completions.useProjectContext', "Include project conventions and patterns in completion prompts."),
		},
		'nyrve.completions.enabledLanguages': {
			type: 'array',
			items: { type: 'string' },
			default: ['*'],
			description: localize('nyrve.completions.enabledLanguages', "Languages to enable completions for (* = all)."),
		},
		'nyrve.completions.disabledLanguages': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('nyrve.completions.disabledLanguages', "Languages to disable completions for (overrides enabled list)."),
		},
	}
});

// Vision settings (v3)
configurationRegistry.registerConfiguration({
	id: 'nyrve.vision',
	title: localize('nyrveVisionTitle', "Nyrve Vision"),
	order: 212,
	type: 'object',
	properties: {
		'nyrve.vision.enabled': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.vision.enabled', "Enable image input for the agent (paste, drag-drop, file picker)."),
		},
		'nyrve.vision.maxImageDimension': {
			type: 'number',
			default: 2048,
			minimum: 512,
			maximum: 4096,
			description: localize('nyrve.vision.maxImageDimension', "Maximum image dimension in pixels (longest side). Images are resized to fit."),
		},
		'nyrve.vision.compressionQuality': {
			type: 'number',
			default: 85,
			minimum: 50,
			maximum: 100,
			description: localize('nyrve.vision.compressionQuality', "JPEG compression quality (50-100) for images exceeding the size limit."),
		},
		'nyrve.vision.maxFileSize': {
			type: 'number',
			default: 20,
			minimum: 1,
			maximum: 20,
			description: localize('nyrve.vision.maxFileSize', "Maximum image file size in MB."),
		},
		'nyrve.vision.stripExif': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.vision.stripExif', "Strip EXIF metadata from images for privacy (location, camera info)."),
		},
		'nyrve.vision.showPreview': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.vision.showPreview', "Show image preview thumbnails in the Agent Panel."),
		},
	}
});

// Plan mode settings (v3)
configurationRegistry.registerConfiguration({
	id: 'nyrve.plan',
	title: localize('nyrvePlanTitle', "Nyrve Plan Mode"),
	order: 211,
	type: 'object',
	properties: {
		'nyrve.plan.model': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet'],
			default: 'claude-sonnet',
			description: localize('nyrve.plan.model', "Claude model for plan generation (Sonnet default, Opus for complex tasks)."),
		},
		'nyrve.plan.autoVerify': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.plan.autoVerify', "Run verification after each step execution."),
		},
		'nyrve.plan.autoProceed': {
			type: 'boolean',
			default: false,
			description: localize('nyrve.plan.autoProceed', "Automatically proceed to next step after verification (no manual confirmation)."),
		},
		'nyrve.plan.maxSteps': {
			type: 'number',
			default: 20,
			minimum: 1,
			maximum: 50,
			description: localize('nyrve.plan.maxSteps', "Maximum steps in a single plan."),
		},
		'nyrve.plan.suggestForComplexTasks': {
			type: 'boolean',
			default: true,
			description: localize('nyrve.plan.suggestForComplexTasks', "Suggest Plan Mode when the agent detects a complex task."),
		},
	}
});

// Privacy settings
configurationRegistry.registerConfiguration({
	id: 'nyrve.privacy',
	title: localize('nyrvePrivacyTitle', "Nyrve Privacy"),
	order: 208,
	type: 'object',
	properties: {
		'nyrve.telemetry.enabled': {
			type: 'boolean',
			default: false,
			description: localize('nyrve.telemetry.enabled', "Enable anonymous usage analytics (opt-in only)."),
		},
		'nyrve.memory.cloudSync': {
			type: 'boolean',
			default: false,
			description: localize('nyrve.memory.cloudSync', "Sync project memory across machines via encrypted cloud backup (opt-in only)."),
		},
	}
});
