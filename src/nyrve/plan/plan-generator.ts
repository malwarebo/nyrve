/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveApiClient, AnthropicStreamEvent } from '../core/api-client.js';
import { INyrveAuthService } from '../core/auth-service.js';
import { INyrveModelRouter, NyrveTaskComplexity } from '../agent/model-router.js';
import { INyrveTokenTracker } from '../agent/token-tracker.js';
import { INyrveMemoryRetriever, MemoryContext } from '../memory/memory-retriever.js';
import {
	Plan,
	PlanStep,
	PlanStatus,
	StepStatus,
	PlanRequest,
	PlanEstimate,
	INyrvePlanStorage,
	PlannedAction,
} from './plan-types.js';

// --- Service Interface ---

export const INyrvePlanGenerator = createDecorator<INyrvePlanGenerator>('nyrvePlanGenerator');

export interface INyrvePlanGenerator {
	readonly _serviceBrand: undefined;

	/** Generate a plan from a user request. */
	generatePlan(request: PlanRequest): Promise<Plan>;

	/** Revise a plan based on user feedback. */
	revisePlan(plan: Plan, feedback: string): Promise<Plan>;

	/** Estimate cost and time for a plan. */
	estimatePlan(plan: Plan): Promise<PlanEstimate>;
}

// --- Constants ---

const PLAN_SYSTEM_PROMPT = `You are a senior software architect planning a code change. Analyze the codebase and create a step-by-step implementation plan.

Rules:
- Steps should be small and focused (one logical change per step)
- Order steps so dependencies come first
- Include a step for writing/updating tests
- Follow the project conventions listed below
- If the task is large (>10 steps), group steps into phases

Output your response as a JSON object matching this structure:
{"title":"short title (max 8 words)","description":"summary of what the plan accomplishes","steps":[{"title":"step title","description":"detailed description","actions":[{"type":"create_file|modify_file|delete_file|run_command|install_package","filePath":"path/to/file","description":"what this action does","command":"npm install ...","estimatedLinesChanged":50}],"dependsOn":[]}],"estimatedTokens":50000,"estimatedTime":"~5 minutes"}

Only output valid JSON. No markdown, no explanation outside the JSON.`;

const REVISE_SYSTEM_PROMPT = `You are revising a software implementation plan based on user feedback. Update the plan structure while maintaining the same JSON format. Only output valid JSON.`;

// --- Implementation ---

export class NyrvePlanGenerator extends Disposable implements INyrvePlanGenerator {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveApiClient private readonly apiClient: INyrveApiClient,
		@INyrveAuthService private readonly authService: INyrveAuthService,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveTokenTracker private readonly tokenTracker: INyrveTokenTracker,
		@INyrveMemoryRetriever private readonly memoryRetriever: INyrveMemoryRetriever,
		@INyrvePlanStorage private readonly planStorage: INyrvePlanStorage,
		@IConfigurationService _configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async generatePlan(request: PlanRequest): Promise<Plan> {
		const apiKey = await this.authService.getApiKey();
		if (!apiKey) {
			throw new Error('No API key configured');
		}

		// Use Sonnet or Opus for planning (not Haiku — needs reasoning)
		const modelId = this.modelRouter.selectModel(NyrveTaskComplexity.High);
		const apiModelId = this.modelRouter.getApiModelId(modelId);

		// Get memory context
		const memoryContext = await this.memoryRetriever.retrieve(request.userMessage);
		const memoryUsed: string[] = [];
		if (memoryContext.projectDNA) {
			memoryUsed.push('project-dna');
		}
		if (memoryContext.relevantDecisions) {
			memoryUsed.push('decisions');
		}

		// Build user prompt
		const userPrompt = this._buildUserPrompt(request, memoryContext);

		// Stream the response
		let responseText = '';
		let inputTokens = 0;
		let outputTokens = 0;

		await this.apiClient.stream(
			apiKey,
			{
				model: apiModelId,
				max_tokens: 4096,
				system: PLAN_SYSTEM_PROMPT,
				messages: [{ role: 'user', content: userPrompt }],
				temperature: 0.2,
			},
			(event: AnthropicStreamEvent) => {
				if (event.type === 'content_block_delta') {
					const delta = event as AnthropicStreamEvent & { delta?: { text?: string } };
					if (delta.delta?.text) {
						responseText += delta.delta.text;
					}
				} else if (event.type === 'message_delta') {
					const msgDelta = event as AnthropicStreamEvent & { usage?: { output_tokens?: number } };
					if (msgDelta.usage?.output_tokens != null) {
						outputTokens = msgDelta.usage.output_tokens;
					}
				} else if (event.type === 'message_start') {
					const msgStart = event as AnthropicStreamEvent & { message?: { usage?: { input_tokens?: number } } };
					if (msgStart.message?.usage?.input_tokens != null) {
						inputTokens = msgStart.message.usage.input_tokens;
					}
				}
			},
		);

		// Track tokens
		this.tokenTracker.recordUsage(modelId, inputTokens, outputTokens);

		// Parse the plan
		const plan = this._parsePlanResponse(responseText, request, memoryUsed);

		// Store active plan
		this.planStorage.setActivePlan(plan);
		await this.planStorage.save(plan);

		this.logService.info(`[Nyrve] Plan generated: "${plan.title}" with ${plan.steps.length} steps`);
		return plan;
	}

	async revisePlan(plan: Plan, feedback: string): Promise<Plan> {
		const apiKey = await this.authService.getApiKey();
		if (!apiKey) {
			throw new Error('No API key configured');
		}

		const modelId = this.modelRouter.selectModel(NyrveTaskComplexity.High);
		const apiModelId = this.modelRouter.getApiModelId(modelId);

		const userPrompt = `## Current Plan
${JSON.stringify(plan, null, 2)}

## User Feedback
${feedback}

Revise the plan based on the feedback. Output the complete revised plan as JSON.`;

		let responseText = '';
		let inputTokens = 0;
		let outputTokens = 0;

		await this.apiClient.stream(
			apiKey,
			{
				model: apiModelId,
				max_tokens: 4096,
				system: REVISE_SYSTEM_PROMPT,
				messages: [{ role: 'user', content: userPrompt }],
				temperature: 0.2,
			},
			(event: AnthropicStreamEvent) => {
				if (event.type === 'content_block_delta') {
					const delta = event as AnthropicStreamEvent & { delta?: { text?: string } };
					if (delta.delta?.text) {
						responseText += delta.delta.text;
					}
				} else if (event.type === 'message_delta') {
					const msgDelta = event as AnthropicStreamEvent & { usage?: { output_tokens?: number } };
					if (msgDelta.usage?.output_tokens != null) {
						outputTokens = msgDelta.usage.output_tokens;
					}
				} else if (event.type === 'message_start') {
					const msgStart = event as AnthropicStreamEvent & { message?: { usage?: { input_tokens?: number } } };
					if (msgStart.message?.usage?.input_tokens != null) {
						inputTokens = msgStart.message.usage.input_tokens;
					}
				}
			},
		);

		this.tokenTracker.recordUsage(modelId, inputTokens, outputTokens);

		// Parse and merge with existing plan metadata
		const revised = this._parsePlanResponse(responseText, {
			userMessage: plan.userRequest,
			activeFile: undefined,
			selectedCode: undefined,
			mentionedFiles: undefined,
		}, plan.memoryUsed);

		// Preserve the original plan ID and creation timestamp
		const updatedPlan: Plan = {
			...revised,
			id: plan.id,
			createdAt: plan.createdAt,
			status: PlanStatus.Review,
		};

		this.planStorage.setActivePlan(updatedPlan);
		await this.planStorage.save(updatedPlan);

		this.logService.info(`[Nyrve] Plan revised: "${updatedPlan.title}"`);
		return updatedPlan;
	}

	async estimatePlan(plan: Plan): Promise<PlanEstimate> {
		let totalLines = 0;
		let totalActions = 0;

		for (const step of plan.steps) {
			totalActions += step.actions.length;
			for (const action of step.actions) {
				totalLines += action.estimatedLinesChanged ?? 30;
			}
		}

		// Rough estimation: ~100 tokens per line changed + overhead per step
		const estimatedTokens = (totalLines * 100) + (plan.steps.length * 2000);
		const costPerToken = 0.003 / 1000; // Sonnet input price as approximation
		const estimatedCost = estimatedTokens * costPerToken;

		// ~30 seconds per step for simple, 60 for moderate, 120 for complex
		const complexity = plan.steps.length <= 3 ? 'simple' : plan.steps.length <= 8 ? 'moderate' : 'complex';
		const secondsPerStep = complexity === 'simple' ? 30 : complexity === 'moderate' ? 60 : 120;
		const totalSeconds = plan.steps.length * secondsPerStep;
		const estimatedTime = totalSeconds < 60 ? `~${totalSeconds}s` :
			totalSeconds < 3600 ? `~${Math.ceil(totalSeconds / 60)} minutes` :
				`~${Math.ceil(totalSeconds / 3600)} hours`;

		return {
			estimatedTokens,
			estimatedCost,
			estimatedTime,
			estimatedSteps: plan.steps.length,
			complexity,
		};
	}

	private _buildUserPrompt(
		request: PlanRequest,
		memoryContext: MemoryContext,
	): string {
		const parts: string[] = [];

		parts.push('## User Request');
		parts.push(request.userMessage);
		parts.push('');

		if (memoryContext.contextString) {
			parts.push('## Project Context');
			parts.push(memoryContext.contextString);
			parts.push('');
		}

		if (request.activeFile) {
			parts.push(`## Active File: ${request.activeFile}`);
		}

		if (request.selectedCode) {
			parts.push('## Selected Code');
			parts.push('```');
			parts.push(request.selectedCode);
			parts.push('```');
			parts.push('');
		}

		if (request.mentionedFiles && request.mentionedFiles.length > 0) {
			parts.push('## Referenced Files');
			parts.push(request.mentionedFiles.join('\n'));
			parts.push('');
		}

		parts.push('Create a detailed step-by-step plan for this request.');
		return parts.join('\n');
	}

	private _parsePlanResponse(response: string, request: PlanRequest, memoryUsed: string[]): Plan {
		// Extract JSON from response (may have leading/trailing text)
		let jsonStr = response.trim();
		const jsonStart = jsonStr.indexOf('{');
		const jsonEnd = jsonStr.lastIndexOf('}');
		if (jsonStart >= 0 && jsonEnd > jsonStart) {
			jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
		}

		let parsed: {
			title?: string;
			description?: string;
			steps?: Array<{
				title?: string;
				description?: string;
				actions?: PlannedAction[];
				dependsOn?: string[];
			}>;
			estimatedTokens?: number;
			estimatedTime?: string;
		};

		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			this.logService.warn('[Nyrve] Failed to parse plan response as JSON, creating fallback');
			parsed = {
				title: 'Implementation Plan',
				description: request.userMessage,
				steps: [{
					title: 'Execute Request',
					description: request.userMessage,
					actions: [],
					dependsOn: [],
				}],
			};
		}

		const now = new Date().toISOString();
		const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

		const steps: PlanStep[] = (parsed.steps ?? []).map((s, i) => ({
			id: `step_${i + 1}`,
			index: i,
			title: s.title ?? `Step ${i + 1}`,
			description: s.description ?? '',
			actions: s.actions ?? [],
			dependsOn: s.dependsOn ?? [],
			status: StepStatus.Pending,
			userModified: false,
			userNotes: '',
		}));

		return {
			id: planId,
			title: parsed.title ?? 'Implementation Plan',
			description: parsed.description ?? request.userMessage,
			userRequest: request.userMessage,
			steps,
			status: PlanStatus.Review,
			currentStepIndex: 0,
			filesAnalyzed: request.mentionedFiles ?? [],
			memoryUsed,
			createdAt: now,
			updatedAt: now,
			estimatedTokens: parsed.estimatedTokens ?? 0,
			estimatedTime: parsed.estimatedTime ?? 'unknown',
			executionResults: [],
		};
	}
}

registerSingleton(INyrvePlanGenerator, NyrvePlanGenerator, InstantiationType.Delayed);
