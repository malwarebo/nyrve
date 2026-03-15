/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../vs/base/browser/dom.js';
import { Codicon } from '../../../vs/base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../vs/base/common/keyCodes.js';
import { localize, localize2 } from '../../../vs/nls.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../vs/platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../vs/platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../vs/platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../vs/platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../vs/platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../vs/platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../vs/platform/opener/common/opener.js';
import { Registry } from '../../../vs/platform/registry/common/platform.js';
import { registerIcon } from '../../../vs/platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../vs/platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../vs/workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../vs/workbench/browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../vs/workbench/common/views.js';
import { IViewDescriptorService } from '../../../vs/workbench/common/views.js';
import { ForgeAgentState, IForgeAgentService } from '../../agent/agent-service.js';
import { ForgeStreamEvent } from '../../agent/agent-engine.js';
import { IForgeModelRouter } from '../../agent/model-router.js';
import { IForgeTokenTracker } from '../../agent/token-tracker.js';
import { ForgePanelHeader, PanelMode } from './panel-header.js';
import { ForgeWelcomeState, ProjectStatusItem } from './welcome-state.js';
import { ForgeInputBar } from './input-bar.js';
import { ForgeMessageRenderer } from './message-renderer.js';

// --- Constants ---

export const FORGE_AGENT_VIEW_CONTAINER_ID = 'workbench.view.forgeAgent';
export const FORGE_AGENT_VIEW_ID = 'workbench.view.forgeAgent.chat';

// --- ForgeAgentViewPane ---

export class ForgeAgentViewPane extends ViewPane {

	private container!: HTMLElement;
	private panelHeader!: ForgePanelHeader;
	private welcomeState!: ForgeWelcomeState;
	private messageRenderer!: ForgeMessageRenderer;
	private inputBar!: ForgeInputBar;
	private contentArea!: HTMLElement;

	private currentStreamContent = '';

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
		@IForgeAgentService private readonly agentService: IForgeAgentService,
		@IForgeModelRouter private readonly modelRouter: IForgeModelRouter,
		@IForgeTokenTracker private readonly tokenTracker: IForgeTokenTracker,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.agentService.onDidChangeState(state => this._onAgentStateChanged(state)));
		this._register(this.agentService.onDidAddMessage(msg => {
			if (msg.role === 'user') {
				this.messageRenderer.appendUserMessage(msg.content);
				this._showConversation();
			}
		}));
		this._register(this.agentService.onDidReceiveStreamEvent(e => this._handleStreamEvent(e)));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.container = container;
		this.container.classList.add('forge-agent-panel');

		// Set styles individually — do NOT use cssText which wipes VS Code's managed styles
		this.container.style.display = 'flex';
		this.container.style.flexDirection = 'column';
		this.container.style.background = '#1e1d1a';

		// --- Header ---
		let activeModel: string;
		let availableModels: string[];
		try {
			activeModel = this.agentService.getActiveModel();
			availableModels = this.modelRouter.getAvailableModels();
		} catch {
			activeModel = 'claude-sonnet';
			availableModels = ['claude-opus', 'claude-sonnet', 'claude-haiku'];
		}

		this.panelHeader = this._register(new ForgePanelHeader({
			currentMode: 'agent',
			currentModel: activeModel,
			availableModels: availableModels as import('../../core/config.js').ForgeModelId[],
			taskQueueCount: 0,
		}));
		this.panelHeader.render(this.container);

		this._register(this.panelHeader.onDidChangeMode(mode => this._onModeChanged(mode)));
		this._register(this.panelHeader.onDidChangeModel(model => {
			this.agentService.setActiveModel(model);
		}));
		this._register(this.panelHeader.onDidClickClose(() => {
			// Close the panel by toggling visibility
			this.setExpanded(false);
		}));

		// --- Content area (welcome state + messages) ---
		this.contentArea = $('div.forge-content-area');
		this.contentArea.style.flex = '1';
		this.contentArea.style.display = 'flex';
		this.contentArea.style.flexDirection = 'column';
		this.contentArea.style.overflow = 'hidden';
		this.contentArea.style.position = 'relative';

		// Welcome state
		this.welcomeState = this._register(new ForgeWelcomeState());
		this.welcomeState.render(this.contentArea);

		this._register(this.welcomeState.onDidClickQuickAction(template => {
			this.inputBar.setValue(template);
			this.inputBar.focus();
		}));
		this._register(this.welcomeState.onDidClickContextChip(chip => {
			this.inputBar.appendValue(chip);
			this.inputBar.focus();
		}));

		// Message renderer (hidden initially)
		this.messageRenderer = this._register(new ForgeMessageRenderer());
		this.messageRenderer.render(this.contentArea);

		this.container.appendChild(this.contentArea);

		// --- Input bar ---
		this.inputBar = this._register(new ForgeInputBar());
		this.inputBar.render(this.container);

		this._register(this.inputBar.onDidSubmit(content => this._sendMessage(content)));
		this._register(this.inputBar.onDidCancel(() => {
			// TODO: cancel current agent generation
		}));
		this._register(this.inputBar.onDidClickMention(() => {
			this.inputBar.appendValue('@');
			this.inputBar.focus();
		}));

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
		this.container.style.display = 'flex';
		this.container.style.flexDirection = 'column';
	}

	private async _sendMessage(content: string): Promise<void> {
		if (this.agentService.state !== ForgeAgentState.Idle) {
			return;
		}

		this.currentStreamContent = '';
		this._showConversation();

		try {
			await this.agentService.sendUserMessage(content);
		} catch (e) {
			this.messageRenderer.appendErrorMessage(e instanceof Error ? e.message : String(e));
		}
	}

	private _handleStreamEvent(event: ForgeStreamEvent): void {
		if (event.type === 'message_start') {
			this.currentStreamContent = '';
			this.messageRenderer.startStreaming();
		} else if (event.type === 'text_delta' && event.text) {
			this.currentStreamContent += event.text;
			this.messageRenderer.updateStreaming(this.currentStreamContent);
		} else if (event.type === 'message_stop') {
			this.messageRenderer.finalizeStreaming();
		} else if (event.type === 'error' && event.error) {
			this.messageRenderer.appendErrorMessage(event.error);
		}
	}

	private _onAgentStateChanged(state: ForgeAgentState): void {
		const isGenerating = state === ForgeAgentState.Thinking || state === ForgeAgentState.Streaming;
		this.inputBar.setGenerating(isGenerating);

		if (state === ForgeAgentState.Thinking) {
			this.messageRenderer.showThinking();
		}

		this._updateStatusBar();
	}

	private _onModeChanged(mode: PanelMode): void {
		// TODO: switch content area between agent chat, plan panel, and task queue
		// For now, mode switching is a no-op beyond the header label update
		if (mode === 'agent') {
			this._updateWelcomeVisibility();
		}
	}

	private _showConversation(): void {
		this.welcomeState.hide();
	}

	private _updateWelcomeVisibility(): void {
		const conversation = this.agentService.getConversation();
		if (conversation.messages.length === 0) {
			this.welcomeState.show();
		} else {
			this.welcomeState.hide();
		}
	}

	private _renderExistingMessages(): void {
		const conversation = this.agentService.getConversation();
		for (const msg of conversation.messages) {
			if (msg.role === 'user') {
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
		// Populate with default/placeholder values — will be connected to real services later
		const items: ProjectStatusItem[] = [
			{ label: 'DNA', value: 'Not scanned', dotColor: '#5F5E5A' },
			{ label: 'Verification', value: 'Not detected', dotColor: '#5F5E5A' },
			{ label: 'Memory', value: 'No data yet', dotColor: '#5F5E5A' },
		];
		this.welcomeState.updateProjectStatus(items);
	}
}

// --- View Container & View Registration (must come after class declaration) ---

// Activity bar icon — using Codicon.sparkle until a custom Forge flame icon font is registered
const forgeAgentViewIcon = registerIcon('forge-agent-view-icon', Codicon.sparkle, localize('forgeAgentViewIcon', 'View icon of the Forge Agent panel.'));

const forgeAgentViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: FORGE_AGENT_VIEW_CONTAINER_ID,
	title: localize2('forge.agent.viewContainer.label', "Forge Agent"),
	icon: forgeAgentViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [FORGE_AGENT_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: FORGE_AGENT_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	order: 100,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

const forgeAgentViewDescriptor: IViewDescriptor = {
	id: FORGE_AGENT_VIEW_ID,
	containerIcon: forgeAgentViewContainer.icon,
	containerTitle: forgeAgentViewContainer.title.value,
	singleViewPaneContainerTitle: forgeAgentViewContainer.title.value,
	name: localize2('forge.agent.viewContainer.label', "Forge Agent"),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: FORGE_AGENT_VIEW_CONTAINER_ID,
		title: forgeAgentViewContainer.title,
		mnemonicTitle: localize({ key: 'miToggleForgeAgent', comment: ['&& denotes a mnemonic'] }, "Forge &&Agent"),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
		},
		order: 100,
	},
	ctorDescriptor: new SyncDescriptor(ForgeAgentViewPane),
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([forgeAgentViewDescriptor], forgeAgentViewContainer);
