/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
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
import { NyrveAgentState, INyrveAgentService } from '../../agent/agent-service.js';
import { NyrveStreamEvent } from '../../agent/agent-engine.js';
import { INyrveModelRouter } from '../../agent/model-router.js';
import { INyrveTokenTracker } from '../../agent/token-tracker.js';
import { NyrvePanelHeader, PanelMode } from './panel-header.js';
import { NyrveWelcomeState, ProjectStatusItem } from './welcome-state.js';
import { NyrveInputBar } from './input-bar.js';
import { NyrveMessageRenderer } from './message-renderer.js';

// --- Constants ---

export const NYRVE_AGENT_VIEW_CONTAINER_ID = 'workbench.view.nyrveAgent';
export const NYRVE_AGENT_VIEW_ID = 'workbench.view.nyrveAgent.chat';

// --- NyrveAgentViewPane ---

export class NyrveAgentViewPane extends ViewPane {

	private container!: HTMLElement;
	private panelHeader!: NyrvePanelHeader;
	private welcomeState!: NyrveWelcomeState;
	private messageRenderer!: NyrveMessageRenderer;
	private inputBar!: NyrveInputBar;
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
		@INyrveAgentService private readonly agentService: INyrveAgentService,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveTokenTracker private readonly tokenTracker: INyrveTokenTracker,
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
		this.container.classList.add('nyrve-agent-panel');

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

		this.panelHeader = this._register(new NyrvePanelHeader({
			currentMode: 'agent',
			currentModel: activeModel,
			availableModels: availableModels as import('../../core/config.js').NyrveModelId[],
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
		this.contentArea = $('div.nyrve-content-area');
		this.contentArea.style.flex = '1';
		this.contentArea.style.display = 'flex';
		this.contentArea.style.flexDirection = 'column';
		this.contentArea.style.overflow = 'hidden';
		this.contentArea.style.position = 'relative';

		// Welcome state
		this.welcomeState = this._register(new NyrveWelcomeState());
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
		this.messageRenderer = this._register(new NyrveMessageRenderer());
		this.messageRenderer.render(this.contentArea);

		this.container.appendChild(this.contentArea);

		// --- Input bar ---
		this.inputBar = this._register(new NyrveInputBar());
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
		if (this.agentService.state !== NyrveAgentState.Idle) {
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

	private _handleStreamEvent(event: NyrveStreamEvent): void {
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

	private _onAgentStateChanged(state: NyrveAgentState): void {
		const isGenerating = state === NyrveAgentState.Thinking || state === NyrveAgentState.Streaming;
		this.inputBar.setGenerating(isGenerating);

		if (state === NyrveAgentState.Thinking) {
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

// Activity bar icon — using Codicon.sparkle until a custom Nyrve flame icon font is registered
const nyrveAgentViewIcon = registerIcon('nyrve-agent-view-icon', Codicon.sparkle, localize('nyrveAgentViewIcon', 'View icon of the Nyrve Agent panel.'));

const nyrveAgentViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: NYRVE_AGENT_VIEW_CONTAINER_ID,
	title: localize2('nyrve.agent.viewContainer.label', "Nyrve Agent"),
	icon: nyrveAgentViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [NYRVE_AGENT_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: NYRVE_AGENT_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	order: 100,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

const nyrveAgentViewDescriptor: IViewDescriptor = {
	id: NYRVE_AGENT_VIEW_ID,
	containerIcon: nyrveAgentViewContainer.icon,
	containerTitle: nyrveAgentViewContainer.title.value,
	singleViewPaneContainerTitle: nyrveAgentViewContainer.title.value,
	name: localize2('nyrve.agent.viewContainer.label', "Nyrve Agent"),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: NYRVE_AGENT_VIEW_CONTAINER_ID,
		title: nyrveAgentViewContainer.title,
		mnemonicTitle: localize({ key: 'miToggleNyrveAgent', comment: ['&& denotes a mnemonic'] }, "Nyrve &&Agent"),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
		},
		order: 100,
	},
	ctorDescriptor: new SyncDescriptor(NyrveAgentViewPane),
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([nyrveAgentViewDescriptor], nyrveAgentViewContainer);
