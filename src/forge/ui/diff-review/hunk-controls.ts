/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { $, addDisposableListener } from '../../../vs/base/browser/dom.js';
import { localize } from '../../../vs/nls.js';
import { ICodeEditor, IViewZoneChangeAccessor } from '../../../vs/editor/browser/editorBrowser.js';
import { IEditorContribution } from '../../../vs/editor/common/editorCommon.js';
import { registerEditorContribution } from '../../../vs/editor/browser/editorExtensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { ForgeHunk, HunkStatus, IForgeDiffService } from './diff-panel.js';

/**
 * Editor contribution that renders per-hunk accept/reject controls
 * as view zones in the diff editor gutter area.
 */
export class ForgeHunkControlsContribution extends Disposable implements IEditorContribution {

	static readonly ID = 'forge.hunkControlsContribution';

	private readonly _viewZoneIds: string[] = [];
	private readonly _zoneDisposables = this._register(new DisposableStore());

	constructor(
		private readonly _editor: ICodeEditor,
		@IForgeDiffService private readonly _diffService: IForgeDiffService,
		@ILogService _logService: ILogService,
	) {
		super();

		this._register(this._diffService.onDidProposeChangeSet(() => this._renderHunkControls()));
		this._register(this._diffService.onDidChangeHunkStatus(() => this._renderHunkControls()));
		this._register(this._diffService.onDidChangeStatus(() => this._renderHunkControls()));
	}

	private _renderHunkControls(): void {
		const changeSet = this._diffService.getActiveChangeSet();
		if (!changeSet) {
			this._clearZones();
			return;
		}

		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const filePath = model.uri.fsPath;
		const file = changeSet.files.find(f => f.filePath === filePath);
		if (!file) {
			this._clearZones();
			return;
		}

		this._clearZones();
		this._zoneDisposables.clear();

		this._editor.changeViewZones(accessor => {
			for (const hunk of file.hunks) {
				if (hunk.status === HunkStatus.Pending) {
					this._addHunkZone(accessor, changeSet.id, hunk);
				}
			}
		});
	}

	private _addHunkZone(accessor: IViewZoneChangeAccessor, changeSetId: string, hunk: ForgeHunk): void {
		const domNode = this._createHunkControlsDom(changeSetId, hunk);

		const zoneId = accessor.addZone({
			afterLineNumber: hunk.startLine - 1,
			heightInPx: 28,
			domNode,
			suppressMouseDown: false,
		});

		this._viewZoneIds.push(zoneId);
	}

	private _createHunkControlsDom(changeSetId: string, hunk: ForgeHunk): HTMLElement {
		const container = $('div.forge-hunk-controls');
		container.style.cssText = 'display: flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 11px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border);';

		// Accept button
		const acceptBtn = $('button.forge-hunk-accept');
		acceptBtn.textContent = localize('forge.hunk.accept', "Accept");
		acceptBtn.title = localize('forge.hunk.acceptTitle', "Accept this change (Cmd+Shift+Y)");
		acceptBtn.style.cssText = 'padding: 1px 8px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; font-size: 11px;';
		this._zoneDisposables.add(addDisposableListener(acceptBtn, 'click', () => {
			this._diffService.acceptHunk(changeSetId, hunk.id);
		}));
		container.appendChild(acceptBtn);

		// Reject button
		const rejectBtn = $('button.forge-hunk-reject');
		rejectBtn.textContent = localize('forge.hunk.reject', "Reject");
		rejectBtn.title = localize('forge.hunk.rejectTitle', "Reject this change (Cmd+Shift+N)");
		rejectBtn.style.cssText = 'padding: 1px 8px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; font-size: 11px;';
		this._zoneDisposables.add(addDisposableListener(rejectBtn, 'click', () => {
			this._diffService.rejectHunk(changeSetId, hunk.id);
		}));
		container.appendChild(rejectBtn);

		// Line range label
		const label = $('span.forge-hunk-label');
		label.style.cssText = 'opacity: 0.7; margin-left: 8px;';
		label.textContent = hunk.startLine === hunk.endLine
			? localize('forge.hunk.lineLabel', "Line {0}", hunk.startLine)
			: localize('forge.hunk.linesLabel', "Lines {0}-{1}", hunk.startLine, hunk.endLine);
		container.appendChild(label);

		return container;
	}

	private _clearZones(): void {
		if (this._viewZoneIds.length === 0) {
			return;
		}

		this._editor.changeViewZones(accessor => {
			for (const id of this._viewZoneIds) {
				accessor.removeZone(id);
			}
		});
		this._viewZoneIds.length = 0;
	}
}

registerEditorContribution(ForgeHunkControlsContribution.ID, ForgeHunkControlsContribution, 0 /* EditorContributionInstantiation.Eager */);
