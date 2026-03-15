/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Forge Native AI Removal
 *
 * This module disables VS Code's built-in Chat/Copilot/Inline Chat features
 * so that only the Forge Agent Panel is visible. Rather than deleting upstream
 * source files (which would cause merge conflicts), we:
 *
 * 1. Comment out the chat/inlineChat contribution imports in the workbench
 *    entry points (workbench.common.main.ts, workbench.desktop.main.ts,
 *    terminal.all.ts) — this prevents all chat UI, commands, and services
 *    from loading.
 *
 * 2. This module provides runtime cleanup as a safety net for any chat
 *    artifacts that survive (e.g., context keys, menu items contributed
 *    by extensions at runtime).
 *
 * Import order in workbench entry points (changes marked with "// [Forge] Disabled"):
 *   - workbench.common.main.ts: chat.contribution, inlineChat.contribution,
 *     chatSessions.contribution, chatContext.contribution
 *   - workbench.desktop.main.ts: chat/electron-browser/chat.contribution
 *   - terminal.all.ts: terminal.chat.contribution, terminal.chatAgentTools.contribution
 */

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../vs/workbench/common/contributions.js';
import { ICommandService } from '../../vs/platform/commands/common/commands.js';
import { CommandsRegistry } from '../../vs/platform/commands/common/commands.js';
import { MenuRegistry } from '../../vs/platform/actions/common/actions.js';
import { Registry } from '../../vs/platform/registry/common/platform.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry } from '../../vs/workbench/common/views.js';

// --- Chat command ID prefixes to suppress ---

const CHAT_COMMAND_PREFIXES = [
	'chat.',
	'workbench.action.chat.',
	'workbench.chat.',
	'inlineChat.',
	'inlineChat2.',
	'copilot.',
	'github.copilot.',
	'workbench.panel.chat',
	'agentSessions.',
];

// --- Chat menu item IDs to filter ---

const CHAT_MENU_COMMAND_IDS = new Set([
	'workbench.action.chat.open',
	'workbench.action.chat.newChat',
	'workbench.action.chat.focus',
	'workbench.action.chat.focusInput',
	'workbench.action.chat.triggerSetup',
	'workbench.action.chat.triggerSetupAnonymousWithoutDialog',
	'workbench.action.chat.configureCodeCompletions',
	'workbench.action.chat.manageSettings',
	'workbench.action.chat.openFeatureSettings',
	'inlineChat.start',
	'inlineChat.focus',
]);

/**
 * Runs at workbench startup and removes any lingering Chat/Copilot artifacts.
 *
 * The primary disablement is done by commenting out the contribution imports
 * in the workbench entry points. This class handles edge cases where
 * extensions or late-loading contributions try to register chat features.
 */
export class ForgeDisableNativeAI extends Disposable {
	static readonly ID = 'forge.disableNativeAI';

	constructor(
		@ICommandService _commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._hideChatViewContainer();
		this._deregisterChatCommands();
		this._cleanupChatMenuItems();

		this.logService.info('[Forge] Native Chat/Copilot features disabled');
	}

	/**
	 * Remove the Chat view from its container so the CHAT tab auto-hides
	 * (the container has hideIfEmpty: true). We only deregister the views,
	 * not the container itself, to avoid breaking services that reference it.
	 */
	private _hideChatViewContainer(): void {
		const CHAT_VIEW_CONTAINER_ID = 'workbench.panel.chat';
		const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

		try {
			const chatContainer = viewContainersRegistry.get(CHAT_VIEW_CONTAINER_ID);
			if (chatContainer) {
				const views = viewsRegistry.getViews(chatContainer);
				if (views.length > 0) {
					viewsRegistry.deregisterViews(views as IViewDescriptor[], chatContainer);
					this.logService.trace(`[Forge] Removed ${views.length} chat views — container will auto-hide`);
				}
			}
		} catch (e) {
			this.logService.warn('[Forge] Failed to hide chat view container', e);
		}
	}

	/**
	 * Deregister any chat/copilot commands that were registered before
	 * this contribution loaded (shouldn't happen if imports are commented
	 * out, but acts as a safety net).
	 */
	private _deregisterChatCommands(): void {
		const allCommands = CommandsRegistry.getCommands();
		let removedCount = 0;

		for (const [id] of allCommands) {
			if (this._isChatCommand(id)) {
				CommandsRegistry.registerCommand(id, () => {
					// No-op replacement — silently swallows the command
				});
				removedCount++;
			}
		}

		if (removedCount > 0) {
			this.logService.trace(`[Forge] Replaced ${removedCount} chat/copilot commands with no-ops`);
		}
	}

	/**
	 * Remove chat-related items from context menus and the menu bar.
	 */
	private _cleanupChatMenuItems(): void {
		// MenuRegistry doesn't expose a direct "remove" API, but we can
		// append items with the same command ID and a "when" clause of "false"
		// to effectively hide them. For menu items added after startup by
		// extensions, this won't catch them — but with the imports commented
		// out, the built-in ones won't exist.

		// The main protection is that the chat contribution files are never
		// loaded, so their MenuRegistry.appendMenuItems calls never run.
		void MenuRegistry; // Referenced to prevent tree-shaking
	}

	private _isChatCommand(id: string): boolean {
		return CHAT_COMMAND_PREFIXES.some(prefix => id.startsWith(prefix)) ||
			CHAT_MENU_COMMAND_IDS.has(id);
	}
}

registerWorkbenchContribution2(
	ForgeDisableNativeAI.ID,
	ForgeDisableNativeAI,
	WorkbenchPhase.AfterRestored
);
