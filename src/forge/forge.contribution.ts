/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
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
import { IForgeDiffService } from './ui/diff-review/diff-panel.js';

// --- Forge Native AI Removal (runtime deregistration of chat UI) ---
// Native chat services remain loaded (required by tasks, debug, notebooks, MCP).
// This contribution hides the Chat/Copilot UI at runtime by replacing commands with no-ops.
import './core/forge-disable-native-ai.js';

// --- Forge Service Registration (side-effect imports trigger registerSingleton) ---
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
import './indexer/forgeignore.js';
import './indexer/symbol-extractor.js';
import './indexer/index-manager.js';
import './ui/diff-review/diff-panel.js';
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

// --- Forge Deep Memory (v2: Three-Layer Memory System) ---
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

// --- Forge Vision (v3: Phase 10) ---
import './vision/image-input.js';
import './vision/image-processor.js';
import './vision/vision-api.js';
import './vision/vision-attachment-ui.js';
import './vision/vision-plan-integration.js';

// --- Forge Plan Mode (v3: Phase 9) ---
import './plan/plan-types.js';
import './plan/plan-generator.js';
import './plan/plan-executor.js';
import './ui/plan/plan-panel.js';

// --- Forge Inline Completions (v3: Phase 8) ---
import './completions/completion-trigger.js';
import './completions/completion-context.js';
import './completions/completion-cache.js';
import './completions/completion-engine.js';
import './completions/completion-postprocessor.js';
import './completions/ghost-text-renderer.js';
import './completions/completion-keybindings.js';
import './completions/completion-stats.js';

// --- Forge Verification UI ---
import './ui/verification/verification-panel.js';

// --- Forge UI Registration ---
import './ui/agent-panel/agent-panel.js';
import './ui/welcome/welcome-page.js';
import './ui/settings/settings-page.js';

// --- Forge Status Bar ---
import { ForgeStatusBarContribution } from './ui/status-bar/forge-status.js';
registerWorkbenchContribution2('forge.statusBar', ForgeStatusBarContribution, WorkbenchPhase.AfterRestored);

// --- Forge Diff Review Keybindings ---

const FORGE_DIFF_CATEGORY = localize2('forge.diff.category', "Forge Diff Review");

registerAction2(class AcceptHunkAction extends Action2 {
	constructor() {
		super({
			id: 'forge.diff.acceptHunk',
			title: localize2('forge.diff.acceptHunk', "Accept Current Hunk"),
			category: FORGE_DIFF_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const diffService = accessor.get(IForgeDiffService);
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
			id: 'forge.diff.rejectHunk',
			title: localize2('forge.diff.rejectHunk', "Reject Current Hunk"),
			category: FORGE_DIFF_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const diffService = accessor.get(IForgeDiffService);
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
			id: 'forge.diff.acceptAll',
			title: localize2('forge.diff.acceptAll', "Accept All Changes"),
			category: FORGE_DIFF_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const diffService = accessor.get(IForgeDiffService);
		const changeSet = diffService.getActiveChangeSet();
		if (changeSet) {
			await diffService.acceptAll(changeSet.id);
		}
	}
});

// --- Forge Plan Mode Keybindings ---

import { IForgePlanPanel } from './ui/plan/plan-panel.js';

const FORGE_PLAN_CATEGORY = localize2('forge.plan.category', "Forge Plan Mode");

registerAction2(class StartPlanModeAction extends Action2 {
	constructor() {
		super({
			id: 'forge.plan.start',
			title: localize2('forge.plan.start', "Start Plan Mode"),
			category: FORGE_PLAN_CATEGORY,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(IForgePlanPanel);
		planPanel.activate();
	}
});

registerAction2(class CancelPlanAction extends Action2 {
	constructor() {
		super({
			id: 'forge.plan.cancel',
			title: localize2('forge.plan.cancel', "Cancel Plan"),
			category: FORGE_PLAN_CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(IForgePlanPanel);
		planPanel.cancelPlan();
	}
});

registerAction2(class PausePlanAction extends Action2 {
	constructor() {
		super({
			id: 'forge.plan.pause',
			title: localize2('forge.plan.pause', "Pause Plan Execution"),
			category: FORGE_PLAN_CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(IForgePlanPanel);
		planPanel.pauseExecution();
	}
});

registerAction2(class ResumePlanAction extends Action2 {
	constructor() {
		super({
			id: 'forge.plan.resume',
			title: localize2('forge.plan.resume', "Resume Plan Execution"),
			category: FORGE_PLAN_CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): void {
		const planPanel = accessor.get(IForgePlanPanel);
		planPanel.resumeExecution();
	}
});

// --- Forge Configuration Registration ---

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

// Agent settings
configurationRegistry.registerConfiguration({
	id: 'forge',
	title: localize('forgeConfigurationTitle', "Forge"),
	order: 200,
	type: 'object',
	properties: {
		'forge.agent.confirmationLevel': {
			type: 'string',
			enum: ['cautious', 'balanced', 'autonomous'],
			enumDescriptions: [
				localize('forge.agent.confirmationLevel.cautious', "Ask for confirmation before every agent action."),
				localize('forge.agent.confirmationLevel.balanced', "Ask for confirmation for file writes and commands, auto-approve reads."),
				localize('forge.agent.confirmationLevel.autonomous', "Agent acts without confirmation (use with caution)."),
			],
			default: 'balanced',
			description: localize('forge.agent.confirmationLevel', "Controls how much confirmation the agent requires before taking actions."),
		},
		'forge.agent.defaultModel': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
			default: 'claude-sonnet',
			description: localize('forge.agent.defaultModel', "The default Claude model used for interactive agent chat."),
		},
		'forge.agent.complexTaskModel': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
			default: 'claude-opus',
			description: localize('forge.agent.complexTaskModel', "The Claude model used for complex multi-file tasks and planning."),
		},
		'forge.agent.backgroundModel': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
			default: 'claude-haiku',
			description: localize('forge.agent.backgroundModel', "The Claude model used for background agent suggestions."),
		},
		'forge.agent.modelSwitcher': {
			type: 'boolean',
			default: true,
			description: localize('forge.agent.modelSwitcher', "Show model selector in the Agent Panel UI."),
		},
		'forge.agent.maxTokensPerRequest': {
			type: 'number',
			default: 100000,
			minimum: 1000,
			maximum: 200000,
			description: localize('forge.agent.maxTokensPerRequest', "Maximum tokens per agent API request."),
		},
		'forge.agent.streamResponses': {
			type: 'boolean',
			default: true,
			description: localize('forge.agent.streamResponses', "Stream agent responses token by token."),
		},
	}
});

// Background agent settings
configurationRegistry.registerConfiguration({
	id: 'forge.backgroundAgent',
	title: localize('forgeBackgroundAgentTitle', "Forge Background Agent"),
	order: 201,
	type: 'object',
	properties: {
		'forge.backgroundAgent.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.backgroundAgent.enabled', "Enable the background agent that passively monitors your code."),
		},
		'forge.backgroundAgent.mode': {
			type: 'string',
			enum: ['active', 'on-save', 'on-commit', 'off'],
			enumDescriptions: [
				localize('forge.backgroundAgent.mode.active', "Monitor and suggest in real-time."),
				localize('forge.backgroundAgent.mode.onSave', "Only analyze on file save."),
				localize('forge.backgroundAgent.mode.onCommit', "Only analyze staged changes before commit."),
				localize('forge.backgroundAgent.mode.off', "Disabled."),
			],
			default: 'on-save',
			description: localize('forge.backgroundAgent.mode', "Controls when the background agent analyzes your code."),
		},
		'forge.backgroundAgent.minSeverity': {
			type: 'string',
			enum: ['info', 'warning', 'critical'],
			default: 'warning',
			description: localize('forge.backgroundAgent.minSeverity', "Minimum severity level for background agent suggestions."),
		},
		'forge.backgroundAgent.dailyTokenBudget': {
			type: 'number',
			default: 500000,
			minimum: 0,
			description: localize('forge.backgroundAgent.dailyTokenBudget', "Maximum daily token spend for background analysis."),
		},
	}
});

// Indexer settings
configurationRegistry.registerConfiguration({
	id: 'forge.indexer',
	title: localize('forgeIndexerTitle', "Forge Indexer"),
	order: 202,
	type: 'object',
	properties: {
		'forge.indexer.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.indexer.enabled', "Enable the codebase indexer for semantic search and context retrieval."),
		},
		'forge.indexer.maxFileSize': {
			type: 'number',
			default: 1048576,
			description: localize('forge.indexer.maxFileSize', "Maximum file size in bytes to index."),
		},
		'forge.indexer.maxProjectFiles': {
			type: 'number',
			default: 50000,
			description: localize('forge.indexer.maxProjectFiles', "Maximum number of files to index per project."),
		},
	}
});

// Context settings
configurationRegistry.registerConfiguration({
	id: 'forge.context',
	title: localize('forgeContextTitle', "Forge Context"),
	order: 203,
	type: 'object',
	properties: {
		'forge.context.defaultTokenBudget': {
			type: 'number',
			default: 30000,
			minimum: 1000,
			description: localize('forge.context.defaultTokenBudget', "Default token budget for agent context."),
		},
	}
});

// Diff review settings
configurationRegistry.registerConfiguration({
	id: 'forge.diff',
	title: localize('forgeDiffTitle', "Forge Diff Review"),
	order: 204,
	type: 'object',
	properties: {
		'forge.diff.autoOpenOnChange': {
			type: 'boolean',
			default: true,
			description: localize('forge.diff.autoOpenOnChange', "Automatically open the diff review panel when the agent proposes changes."),
		},
		'forge.diff.showGutterDecorations': {
			type: 'boolean',
			default: true,
			description: localize('forge.diff.showGutterDecorations', "Show gutter decorations on lines modified by the agent."),
		},
		'forge.diff.highlightDuration': {
			type: 'number',
			default: 30,
			minimum: 0,
			description: localize('forge.diff.highlightDuration', "Duration in seconds to highlight agent-modified lines after acceptance."),
		},
	}
});

// Memory settings (v2: Deep Project Memory)
configurationRegistry.registerConfiguration({
	id: 'forge.memory',
	title: localize('forgeMemoryTitle', "Forge Memory"),
	order: 205,
	type: 'object',
	properties: {
		'forge.memory.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.enabled', "Enable session memory for the agent."),
		},
		'forge.memory.maxEntries': {
			type: 'number',
			default: 1000,
			minimum: 100,
			description: localize('forge.memory.maxEntries', "Maximum memory entries per project."),
		},
		'forge.memory.decayDays': {
			type: 'number',
			default: 90,
			minimum: 7,
			description: localize('forge.memory.decayDays', "Days of inactivity before memory confidence begins to decay."),
		},
		'forge.memory.autoExtract': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.autoExtract', "Automatically extract memories from conversations."),
		},
		'forge.memory.deepMemoryEnabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.deepMemoryEnabled', "Enable the three-layer deep project memory system."),
		},
		// Layer 1: Project DNA
		'forge.memory.dna.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.dna.enabled', "Enable automatic project DNA scanning."),
		},
		'forge.memory.dna.autoScan': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.dna.autoScan', "Automatically scan project when opened."),
		},
		'forge.memory.dna.scanOnOpen': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.dna.scanOnOpen', "Run DNA scan on project open."),
		},
		'forge.memory.dna.incrementalUpdates': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.dna.incrementalUpdates', "Update DNA incrementally on file save."),
		},
		'forge.memory.dna.gitHistoryDays': {
			type: 'number',
			default: 90,
			minimum: 30,
			maximum: 365,
			description: localize('forge.memory.dna.gitHistoryDays', "Number of days of git history to analyze for hotspots."),
		},
		'forge.memory.dna.patternDetectionModel': {
			type: 'string',
			enum: ['claude-haiku', 'claude-sonnet'],
			default: 'claude-haiku',
			description: localize('forge.memory.dna.patternDetectionModel', "Claude model to use for pattern detection."),
		},
		// Layer 2: Decision Journal
		'forge.memory.decisions.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.decisions.enabled', "Enable the decision journal."),
		},
		'forge.memory.decisions.autoExtract': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.decisions.autoExtract', "Auto-extract decisions from conversations."),
		},
		'forge.memory.decisions.extractFromCommits': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.decisions.extractFromCommits', "Auto-extract decisions from git commits."),
		},
		'forge.memory.decisions.extractionModel': {
			type: 'string',
			enum: ['claude-haiku', 'claude-sonnet'],
			default: 'claude-haiku',
			description: localize('forge.memory.decisions.extractionModel', "Claude model to use for decision extraction."),
		},
		'forge.memory.decisions.maxEntries': {
			type: 'number',
			default: 500,
			minimum: 50,
			maximum: 2000,
			description: localize('forge.memory.decisions.maxEntries', "Maximum decision journal entries."),
		},
		// Layer 3: Team Knowledge
		'forge.memory.team.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.team.enabled', "Enable team knowledge file management."),
		},
		'forge.memory.team.filePath': {
			type: 'string',
			default: '.forge/team-knowledge.md',
			description: localize('forge.memory.team.filePath', "Path to the team knowledge file."),
		},
		'forge.memory.team.suggestAdditions': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.team.suggestAdditions', "Agent suggests additions to team knowledge."),
		},
		// Retrieval
		'forge.memory.retrieval.maxTokens': {
			type: 'number',
			default: 3000,
			minimum: 1000,
			maximum: 6000,
			description: localize('forge.memory.retrieval.maxTokens', "Maximum tokens for memory context per agent request."),
		},
		'forge.memory.retrieval.includeAllLayers': {
			type: 'boolean',
			default: true,
			description: localize('forge.memory.retrieval.includeAllLayers', "Include all three memory layers in agent context."),
		},
	}
});

// GitHub settings
configurationRegistry.registerConfiguration({
	id: 'forge.github',
	title: localize('forgeGitHubTitle', "Forge GitHub"),
	order: 206,
	type: 'object',
	properties: {
		'forge.github.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.github.enabled', "Enable GitHub integration features."),
		},
		'forge.github.autoLinkIssues': {
			type: 'boolean',
			default: true,
			description: localize('forge.github.autoLinkIssues', "Automatically link mentioned issue numbers to GitHub issues."),
		},
		'forge.github.ciMonitoring': {
			type: 'boolean',
			default: true,
			description: localize('forge.github.ciMonitoring', "Monitor GitHub Actions workflow status after pushing."),
		},
	}
});

// Task queue settings
configurationRegistry.registerConfiguration({
	id: 'forge.tasks',
	title: localize('forgeTasksTitle', "Forge Task Queue"),
	order: 207,
	type: 'object',
	properties: {
		'forge.tasks.maxConcurrent': {
			type: 'number',
			default: 1,
			minimum: 1,
			maximum: 5,
			description: localize('forge.tasks.maxConcurrent', "Maximum number of concurrent agent tasks."),
		},
		'forge.tasks.dailyTokenBudget': {
			type: 'number',
			default: 1000000,
			minimum: 0,
			description: localize('forge.tasks.dailyTokenBudget', "Maximum daily token spend for task queue execution."),
		},
		'forge.tasks.persistQueue': {
			type: 'boolean',
			default: true,
			description: localize('forge.tasks.persistQueue', "Persist the task queue across editor restarts."),
		},
	}
});

// Verification settings
configurationRegistry.registerConfiguration({
	id: 'forge.verification',
	title: localize('forgeVerificationTitle', "Forge Verification"),
	order: 209,
	type: 'object',
	properties: {
		'forge.verification.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.verification.enabled', "Verify agent changes before showing diffs."),
		},
		'forge.verification.runTypeCheck': {
			type: 'boolean',
			default: true,
			description: localize('forge.verification.runTypeCheck', "Run the project type checker as part of verification."),
		},
		'forge.verification.runTests': {
			type: 'boolean',
			default: true,
			description: localize('forge.verification.runTests', "Run relevant tests as part of verification."),
		},
		'forge.verification.runCoverage': {
			type: 'boolean',
			default: true,
			description: localize('forge.verification.runCoverage', "Check test coverage of agent-changed lines."),
		},
		'forge.verification.runImportCheck': {
			type: 'boolean',
			default: true,
			description: localize('forge.verification.runImportCheck', "Check imports for broken paths and circular dependencies."),
		},
		'forge.verification.coverageThreshold': {
			type: 'number',
			default: 70,
			minimum: 0,
			maximum: 100,
			description: localize('forge.verification.coverageThreshold', "Minimum coverage percentage for changed lines."),
		},
		'forge.verification.maxSelfHealAttempts': {
			type: 'number',
			default: 3,
			minimum: 1,
			maximum: 5,
			description: localize('forge.verification.maxSelfHealAttempts', "Maximum self-heal attempts when verification fails."),
		},
		'forge.verification.selfHealTimeout': {
			type: 'number',
			default: 120000,
			minimum: 30000,
			maximum: 300000,
			description: localize('forge.verification.selfHealTimeout', "Total timeout in ms for the self-heal loop."),
		},
		'forge.verification.testTimeout': {
			type: 'number',
			default: 60000,
			minimum: 15000,
			maximum: 300000,
			description: localize('forge.verification.testTimeout', "Maximum time in ms for a single test run."),
		},
		'forge.verification.addCommitFooter': {
			type: 'boolean',
			default: true,
			description: localize('forge.verification.addCommitFooter', "Add verification footer to agent-created commits."),
		},
		'forge.verification.testCommand': {
			type: 'string',
			default: '',
			description: localize('forge.verification.testCommand', "Override auto-detected test command (empty = auto-detect)."),
		},
		'forge.verification.typeCheckCommand': {
			type: 'string',
			default: '',
			description: localize('forge.verification.typeCheckCommand', "Override auto-detected type check command (empty = auto-detect)."),
		},
		'forge.verification.coverageCommand': {
			type: 'string',
			default: '',
			description: localize('forge.verification.coverageCommand', "Override auto-detected coverage command (empty = auto-detect)."),
		},
	}
});

// Inline completions settings (v3)
configurationRegistry.registerConfiguration({
	id: 'forge.completions',
	title: localize('forgeCompletionsTitle', "Forge Inline Completions"),
	order: 210,
	type: 'object',
	properties: {
		'forge.completions.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.completions.enabled', "Enable AI-powered inline code completions."),
		},
		'forge.completions.model': {
			type: 'string',
			enum: ['claude-haiku', 'claude-sonnet'],
			default: 'claude-haiku',
			description: localize('forge.completions.model', "Claude model for inline completions (Haiku for speed, Sonnet for quality)."),
		},
		'forge.completions.triggerDelay': {
			type: 'number',
			default: 150,
			minimum: 50,
			maximum: 1000,
			description: localize('forge.completions.triggerDelay', "Delay in milliseconds before triggering a completion after typing."),
		},
		'forge.completions.maxLines': {
			type: 'number',
			default: 15,
			minimum: 1,
			maximum: 50,
			description: localize('forge.completions.maxLines', "Maximum lines in a single inline completion."),
		},
		'forge.completions.cacheTTL': {
			type: 'number',
			default: 30,
			minimum: 5,
			maximum: 300,
			description: localize('forge.completions.cacheTTL', "Cache time-to-live in seconds for completion results."),
		},
		'forge.completions.cacheSize': {
			type: 'number',
			default: 100,
			minimum: 10,
			maximum: 1000,
			description: localize('forge.completions.cacheSize', "Maximum number of completions to cache."),
		},
		'forge.completions.useProjectContext': {
			type: 'boolean',
			default: true,
			description: localize('forge.completions.useProjectContext', "Include project conventions and patterns in completion prompts."),
		},
		'forge.completions.enabledLanguages': {
			type: 'array',
			items: { type: 'string' },
			default: ['*'],
			description: localize('forge.completions.enabledLanguages', "Languages to enable completions for (* = all)."),
		},
		'forge.completions.disabledLanguages': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('forge.completions.disabledLanguages', "Languages to disable completions for (overrides enabled list)."),
		},
	}
});

// Vision settings (v3)
configurationRegistry.registerConfiguration({
	id: 'forge.vision',
	title: localize('forgeVisionTitle', "Forge Vision"),
	order: 212,
	type: 'object',
	properties: {
		'forge.vision.enabled': {
			type: 'boolean',
			default: true,
			description: localize('forge.vision.enabled', "Enable image input for the agent (paste, drag-drop, file picker)."),
		},
		'forge.vision.maxImageDimension': {
			type: 'number',
			default: 2048,
			minimum: 512,
			maximum: 4096,
			description: localize('forge.vision.maxImageDimension', "Maximum image dimension in pixels (longest side). Images are resized to fit."),
		},
		'forge.vision.compressionQuality': {
			type: 'number',
			default: 85,
			minimum: 50,
			maximum: 100,
			description: localize('forge.vision.compressionQuality', "JPEG compression quality (50-100) for images exceeding the size limit."),
		},
		'forge.vision.maxFileSize': {
			type: 'number',
			default: 20,
			minimum: 1,
			maximum: 20,
			description: localize('forge.vision.maxFileSize', "Maximum image file size in MB."),
		},
		'forge.vision.stripExif': {
			type: 'boolean',
			default: true,
			description: localize('forge.vision.stripExif', "Strip EXIF metadata from images for privacy (location, camera info)."),
		},
		'forge.vision.showPreview': {
			type: 'boolean',
			default: true,
			description: localize('forge.vision.showPreview', "Show image preview thumbnails in the Agent Panel."),
		},
	}
});

// Plan mode settings (v3)
configurationRegistry.registerConfiguration({
	id: 'forge.plan',
	title: localize('forgePlanTitle', "Forge Plan Mode"),
	order: 211,
	type: 'object',
	properties: {
		'forge.plan.model': {
			type: 'string',
			enum: ['claude-opus', 'claude-sonnet'],
			default: 'claude-sonnet',
			description: localize('forge.plan.model', "Claude model for plan generation (Sonnet default, Opus for complex tasks)."),
		},
		'forge.plan.autoVerify': {
			type: 'boolean',
			default: true,
			description: localize('forge.plan.autoVerify', "Run verification after each step execution."),
		},
		'forge.plan.autoProceed': {
			type: 'boolean',
			default: false,
			description: localize('forge.plan.autoProceed', "Automatically proceed to next step after verification (no manual confirmation)."),
		},
		'forge.plan.maxSteps': {
			type: 'number',
			default: 20,
			minimum: 1,
			maximum: 50,
			description: localize('forge.plan.maxSteps', "Maximum steps in a single plan."),
		},
		'forge.plan.suggestForComplexTasks': {
			type: 'boolean',
			default: true,
			description: localize('forge.plan.suggestForComplexTasks', "Suggest Plan Mode when the agent detects a complex task."),
		},
	}
});

// Privacy settings
configurationRegistry.registerConfiguration({
	id: 'forge.privacy',
	title: localize('forgePrivacyTitle', "Forge Privacy"),
	order: 208,
	type: 'object',
	properties: {
		'forge.telemetry.enabled': {
			type: 'boolean',
			default: false,
			description: localize('forge.telemetry.enabled', "Enable anonymous usage analytics (opt-in only)."),
		},
		'forge.memory.cloudSync': {
			type: 'boolean',
			default: false,
			description: localize('forge.memory.cloudSync', "Sync project memory across machines via encrypted cloud backup (opt-in only)."),
		},
	}
});
