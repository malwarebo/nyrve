/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from "../../../vs/base/browser/dom.js";
import { Codicon } from "../../../vs/base/common/codicons.js";
import { KeyCode, KeyMod } from "../../../vs/base/common/keyCodes.js";
import { localize, localize2 } from "../../../vs/nls.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../vs/platform/contextkey/common/contextkey.js";
import { IContextMenuService } from "../../../vs/platform/contextview/browser/contextView.js";
import { IHoverService } from "../../../vs/platform/hover/browser/hover.js";
import { SyncDescriptor } from "../../../vs/platform/instantiation/common/descriptors.js";
import { IInstantiationService } from "../../../vs/platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../../vs/platform/keybinding/common/keybinding.js";
import { ICommandService } from "../../../vs/platform/commands/common/commands.js";
import { IOpenerService } from "../../../vs/platform/opener/common/opener.js";
import { Registry } from "../../../vs/platform/registry/common/platform.js";
import { registerIcon } from "../../../vs/platform/theme/common/iconRegistry.js";
import { IThemeService } from "../../../vs/platform/theme/common/themeService.js";
import {
	IViewPaneOptions,
	ViewPane,
} from "../../../vs/workbench/browser/parts/views/viewPane.js";
import { ViewPaneContainer } from "../../../vs/workbench/browser/parts/views/viewPaneContainer.js";
import {
	IViewContainersRegistry,
	IViewDescriptor,
	IViewDescriptorService,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation,
	Extensions as ViewExtensions,
} from "../../../vs/workbench/common/views.js";
import {
	NyrveAgentState,
	INyrveAgentService,
} from "../../agent/agent-service.js";
import { NyrveStreamEvent } from "../../agent/agent-engine.js";
import { INyrveModelRouter } from "../../agent/model-router.js";
import { INyrveTokenTracker } from "../../agent/token-tracker.js";
import { INyrvePlanPanel } from "../plan/plan-panel.js";
import { INyrveTaskQueue } from "../task-queue/task-panel.js";
import { NyrvePanelHeader, PanelMode } from "./panel-header.js";
import { NyrveWelcomeState, ProjectStatusItem } from "./welcome-state.js";
import { NyrveInputBar } from "./input-bar.js";
import { NyrveMessageRenderer } from "./message-renderer.js";

// --- Constants ---

export const NYRVE_AGENT_VIEW_CONTAINER_ID = "workbench.view.nyrveAgent";
export const NYRVE_AGENT_VIEW_ID = "workbench.view.nyrveAgent.chat";

// --- NyrveAgentViewPane ---

export class NyrveAgentViewPane extends ViewPane {
	private container!: HTMLElement;
	private panelHeader!: NyrvePanelHeader;
	private welcomeState!: NyrveWelcomeState;
	private messageRenderer!: NyrveMessageRenderer;
	private inputBar!: NyrveInputBar;
	private contentArea!: HTMLElement;

	private agentContent!: HTMLElement;
	private planContent!: HTMLElement;
	private taskContent!: HTMLElement;
	private messagesContainer!: HTMLElement;
	private _currentMode: PanelMode = "agent";

	private currentStreamContent = "";

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@INyrveAgentService private readonly agentService: INyrveAgentService,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveTokenTracker private readonly tokenTracker: INyrveTokenTracker,
		@INyrvePlanPanel private readonly planPanel: INyrvePlanPanel,
		@INyrveTaskQueue private readonly taskQueue: INyrveTaskQueue,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);

		this._register(
			this.agentService.onDidChangeState((state) =>
				this._onAgentStateChanged(state),
			),
		);
		this._register(
			this.agentService.onDidAddMessage((msg) => {
				if (msg.role === "user") {
					this.messageRenderer.appendUserMessage(msg.content);
					this._showConversation();
				}
			}),
		);
		this._register(
			this.agentService.onDidReceiveStreamEvent((e) =>
				this._handleStreamEvent(e),
			),
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.container = container;
		this.container.classList.add("nyrve-agent-panel");

		// Set styles individually — do NOT use cssText which wipes VS Code's managed styles
		this.container.style.display = "flex";
		this.container.style.flexDirection = "column";
		this.container.style.background = "#1e1d1a";

		// --- Header ---
		let activeModel: string;
		let availableModels: string[];
		try {
			activeModel = this.agentService.getActiveModel();
			availableModels = this.modelRouter.getAvailableModels();
		} catch {
			activeModel = "claude-sonnet";
			availableModels = ["claude-opus", "claude-sonnet", "claude-haiku"];
		}

		this.panelHeader = this._register(
			new NyrvePanelHeader({
				currentMode: "agent",
				currentModel: activeModel,
				availableModels:
					availableModels as import("../../core/config.js").NyrveModelId[],
				taskQueueCount: 0,
			}),
		);
		this.panelHeader.render(this.container);

		this._register(
			this.panelHeader.onDidChangeMode((mode) => this._onModeChanged(mode)),
		);
		this._register(
			this.panelHeader.onDidChangeModel((model) => {
				this.agentService.setActiveModel(model);
			}),
		);
		this._register(
			this.panelHeader.onDidClickClose(() => {
				this.setExpanded(false);
			}),
		);
		this._register(
			this.panelHeader.onDidClickSettings(() => {
				this.commandService.executeCommand("nyrve.openSettings");
			}),
		);
		this._register(
			this.panelHeader.onDidClickNewChat(() => {
				this.agentService.newConversation();
				this.messageRenderer.clear();
				this._updateWelcomeVisibility();
			}),
		);

		// --- Content area (welcome state + messages) ---
		this.contentArea = $("div.nyrve-content-area");
		this.contentArea.style.flex = "1";
		this.contentArea.style.display = "flex";
		this.contentArea.style.flexDirection = "column";
		this.contentArea.style.overflow = "hidden";
		this.contentArea.style.position = "relative";

		// Welcome state
		this.welcomeState = this._register(new NyrveWelcomeState());

		// Agent content wrapper
		this.agentContent = $("div.nyrve-agent-content");
		this.agentContent.style.cssText =
			"display: flex; flex-direction: column; flex: 1; overflow: hidden;";
		this.welcomeState.render(this.agentContent);

		// Message renderer (hidden initially — welcome state needs the full space)
		this.messageRenderer = this._register(new NyrveMessageRenderer());
		this.messagesContainer = this.messageRenderer.render(this.agentContent);
		this.messagesContainer.style.display = "none";

		this.contentArea.appendChild(this.agentContent);

		// Plan content (hidden initially)
		this.planContent = $("div.nyrve-plan-content");
		this.planContent.style.cssText =
			"display: none; flex-direction: column; flex: 1; overflow: auto; padding: 12px;";
		this._renderPlanContent();
		this.contentArea.appendChild(this.planContent);

		// Task queue content (hidden initially)
		this.taskContent = $("div.nyrve-task-content");
		this.taskContent.style.cssText =
			"display: none; flex-direction: column; flex: 1; overflow: auto; padding: 12px;";
		this._renderTaskContent();
		this.contentArea.appendChild(this.taskContent);

		this.container.appendChild(this.contentArea);

		this._register(
			this.welcomeState.onDidClickQuickAction((template) => {
				this.inputBar.setValue(template);
				this.inputBar.focus();
			}),
		);
		this._register(
			this.welcomeState.onDidClickContextChip((chip) => {
				this.inputBar.appendValue(chip);
				this.inputBar.focus();
			}),
		);

		// --- Input bar ---
		this.inputBar = this._register(new NyrveInputBar());
		this.inputBar.render(this.container);

		this._register(
			this.inputBar.onDidSubmit((content) => this._sendMessage(content)),
		);
		this._register(
			this.inputBar.onDidCancel(() => {
				this.agentService.cancelCurrentRequest();
			}),
		);
		this._register(
			this.inputBar.onDidClickMention(() => {
				this.inputBar.appendValue("@");
				this.inputBar.focus();
			}),
		);

		// --- Initial state ---
		try {
			this._updateStatusBar();
		} catch {
			// Token tracker not ready yet
		}
		this._renderExistingMessages();
		this._updateWelcomeVisibility();
		this._updateProjectStatus();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.container.style.height = `${height}px`;
		this.container.style.display = "flex";
		this.container.style.flexDirection = "column";
	}

	private async _sendMessage(content: string): Promise<void> {
		if (this.agentService.state !== NyrveAgentState.Idle) {
			return;
		}

		this.currentStreamContent = "";
		this._showConversation();

		try {
			await this.agentService.sendUserMessage(content);
		} catch (e) {
			this.messageRenderer.appendErrorMessage(
				e instanceof Error ? e.message : String(e),
			);
		}
	}

	private _handleStreamEvent(event: NyrveStreamEvent): void {
		if (event.type === "message_start") {
			this.currentStreamContent = "";
			this.messageRenderer.startStreaming();
		} else if (event.type === "text_delta" && event.text) {
			this.currentStreamContent += event.text;
			this.messageRenderer.updateStreaming(this.currentStreamContent);
		} else if (event.type === "message_stop") {
			this.messageRenderer.finalizeStreaming();
		} else if (event.type === "error" && event.error) {
			this.messageRenderer.appendErrorMessage(event.error);
		}
	}

	private _onAgentStateChanged(state: NyrveAgentState): void {
		const isGenerating =
			state === NyrveAgentState.Thinking || state === NyrveAgentState.Streaming;
		this.inputBar.setGenerating(isGenerating);

		if (state === NyrveAgentState.Thinking) {
			this.messageRenderer.showThinking();
		}

		this._updateStatusBar();
	}

	private _onModeChanged(mode: PanelMode): void {
		this._currentMode = mode;

		this.agentContent.style.display = mode === "agent" ? "flex" : "none";
		this.planContent.style.display = mode === "plan" ? "flex" : "none";
		this.taskContent.style.display = mode === "taskqueue" ? "flex" : "none";

		if (mode === "agent") {
			this._updateWelcomeVisibility();
		} else if (mode === "plan") {
			this._renderPlanContent();
		} else if (mode === "taskqueue") {
			this._renderTaskContent();
		}
	}

	private _showConversation(): void {
		this.welcomeState.hide();
		this.messagesContainer.style.display = "";
	}

	private _updateWelcomeVisibility(): void {
		if (this._currentMode !== "agent") {
			this.welcomeState.hide();
			this.messagesContainer.style.display = "";
			return;
		}
		const conversation = this.agentService.getConversation();
		if (conversation.messages.length === 0) {
			this.welcomeState.show();
			this.messagesContainer.style.display = "none";
		} else {
			this.welcomeState.hide();
			this.messagesContainer.style.display = "";
		}
	}

	private _renderExistingMessages(): void {
		const conversation = this.agentService.getConversation();
		for (const msg of conversation.messages) {
			if (msg.role === "user") {
				this.messageRenderer.appendUserMessage(msg.content);
			} else {
				this.messageRenderer.appendAssistantMessage(msg.content);
			}
		}
	}

	private _updateStatusBar(): void {
		const summary = this.tokenTracker.getTodaySummary();
		this.inputBar.updateStatus({
			connected: true,
			hasApiKey: true,
			tokensToday: summary.totalInputTokens + summary.totalOutputTokens,
			avgConfidence: undefined,
		});
	}

	private _updateProjectStatus(): void {
		const items: ProjectStatusItem[] = [
			{ label: "DNA", value: "Not scanned", dotColor: "#5F5E5A" },
			{ label: "Verification", value: "Not detected", dotColor: "#5F5E5A" },
			{ label: "Memory", value: "No data yet", dotColor: "#5F5E5A" },
		];
		this.welcomeState.updateProjectStatus(items);
	}

	private _renderPlanContent(): void {
		this.planContent.textContent = "";
		const state = this.planPanel.state;

		const header = $("div.nyrve-plan-header");
		header.style.cssText =
			"font-size: 13px; font-weight: 600; color: #e8e6de; margin-bottom: 10px;";
		header.textContent = localize("nyrve.plan.title", "Plan Mode");
		this.planContent.appendChild(header);

		if (!state.plan) {
			const empty = $("div.nyrve-plan-empty");
			empty.style.cssText = "font-size: 12px; color: #5F5E5A; padding: 16px 0;";
			empty.textContent = localize(
				"nyrve.plan.empty",
				"No active plan. Type a task in the input bar to generate a plan.",
			);
			this.planContent.appendChild(empty);
			return;
		}

		const statusRow = $("div.nyrve-plan-status");
		statusRow.style.cssText =
			"font-size: 11px; color: #b4b2a9; margin-bottom: 8px;";
		statusRow.textContent = `${state.phase} \u2022 ${state.plan.steps.length} steps`;
		this.planContent.appendChild(statusRow);

		for (let i = 0; i < state.plan.steps.length; i++) {
			const step = state.plan.steps[i];
			const row = $("div.nyrve-plan-step");
			row.style.cssText =
				"display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid #27261f;";

			const indicator = $("span");
			indicator.style.cssText =
				"flex-shrink: 0; font-size: 11px; margin-top: 1px;";
			indicator.textContent =
				i === state.executingStepIndex && state.phase === "executing"
					? "\u25B6"
					: step.status === "completed"
						? "\u2713"
						: step.status === "failed"
							? "\u2717"
							: "\u2022";
			indicator.style.color =
				step.status === "completed"
					? "#5DCAA5"
					: step.status === "failed"
						? "#E24B4A"
						: i === state.executingStepIndex
							? "#EF9F27"
							: "#5F5E5A";
			row.appendChild(indicator);

			const label = $("span");
			label.style.cssText = "font-size: 12px; color: #d3d1c7;";
			label.textContent = step.title;
			row.appendChild(label);

			this.planContent.appendChild(row);
		}
	}

	private _renderTaskContent(): void {
		this.taskContent.textContent = "";
		const tasks = this.taskQueue.getTasks();

		const header = $("div.nyrve-task-header");
		header.style.cssText =
			"font-size: 13px; font-weight: 600; color: #e8e6de; margin-bottom: 10px;";
		header.textContent = localize("nyrve.task.title", "Task Queue");
		this.taskContent.appendChild(header);

		if (tasks.length === 0) {
			const empty = $("div.nyrve-task-empty");
			empty.style.cssText = "font-size: 12px; color: #5F5E5A; padding: 16px 0;";
			empty.textContent = localize("nyrve.task.empty", "No tasks in queue.");
			this.taskContent.appendChild(empty);
			return;
		}

		for (const task of tasks) {
			const row = $("div.nyrve-task-row");
			row.style.cssText =
				"display: flex; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid #27261f;";

			const dot = $("span");
			dot.style.cssText =
				"width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;";
			dot.style.background =
				task.status === "COMPLETED"
					? "#5DCAA5"
					: task.status === "IN_PROGRESS"
						? "#EF9F27"
						: task.status === "FAILED"
							? "#E24B4A"
							: "#5F5E5A";
			row.appendChild(dot);

			const title = $("span");
			title.style.cssText =
				"flex: 1; font-size: 12px; color: #d3d1c7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
			title.textContent = task.title;
			row.appendChild(title);

			const status = $("span");
			status.style.cssText =
				"font-size: 10px; color: #5F5E5A; text-transform: lowercase;";
			status.textContent = task.status.replace("_", " ");
			row.appendChild(status);

			this.taskContent.appendChild(row);
		}
	}
}

// --- View Container & View Registration (must come after class declaration) ---

// Activity bar icon — using Codicon.sparkle until a custom Nyrve flame icon font is registered
const nyrveAgentViewIcon = registerIcon(
	"nyrve-agent-view-icon",
	Codicon.sparkle,
	localize("nyrveAgentViewIcon", "View icon of the Nyrve Agent panel."),
);

const nyrveAgentViewContainer: ViewContainer =
	Registry.as<IViewContainersRegistry>(
		ViewExtensions.ViewContainersRegistry,
	).registerViewContainer(
		{
			id: NYRVE_AGENT_VIEW_CONTAINER_ID,
			title: localize2("nyrve.agent.viewContainer.label", "Nyrve Agent"),
			icon: nyrveAgentViewIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
				NYRVE_AGENT_VIEW_CONTAINER_ID,
				{ mergeViewWithContainerWhenSingleView: true },
			]),
			storageId: NYRVE_AGENT_VIEW_CONTAINER_ID,
			hideIfEmpty: false,
			order: 100,
		},
		ViewContainerLocation.AuxiliaryBar,
		{ doNotRegisterOpenCommand: true },
	);

const nyrveAgentViewDescriptor: IViewDescriptor = {
	id: NYRVE_AGENT_VIEW_ID,
	containerIcon: nyrveAgentViewContainer.icon,
	containerTitle: nyrveAgentViewContainer.title.value,
	singleViewPaneContainerTitle: nyrveAgentViewContainer.title.value,
	name: localize2("nyrve.agent.viewContainer.label", "Nyrve Agent"),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: NYRVE_AGENT_VIEW_CONTAINER_ID,
		title: nyrveAgentViewContainer.title,
		mnemonicTitle: localize(
			{ key: "miToggleNyrveAgent", comment: ["&& denotes a mnemonic"] },
			"Nyrve &&Agent",
		),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
		},
		order: 100,
	},
	ctorDescriptor: new SyncDescriptor(NyrveAgentViewPane),
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[nyrveAgentViewDescriptor],
	nyrveAgentViewContainer,
);
