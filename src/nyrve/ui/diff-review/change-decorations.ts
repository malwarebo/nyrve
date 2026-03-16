/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { ICodeEditor } from '../../../vs/editor/browser/editorBrowser.js';
import { IEditorContribution, IEditorDecorationsCollection } from '../../../vs/editor/common/editorCommon.js';
import { IModelDeltaDecoration, OverviewRulerLane, TrackedRangeStickiness } from '../../../vs/editor/common/model.js';
import { registerEditorContribution } from '../../../vs/editor/browser/editorExtensions.js';
import { Range } from '../../../vs/editor/common/core/range.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { themeColorFromId } from '../../../vs/platform/theme/common/themeService.js';
import { registerColor } from '../../../vs/platform/theme/common/colorRegistry.js';
import { localize } from '../../../vs/nls.js';
import { HunkStatus, INyrveDiffService } from './diff-panel.js';

// --- Theme Colors ---

export const nyrveAddedLineBackground = registerColor('nyrve.addedLineBackground', {
	dark: '#2ea04330',
	light: '#2ea04320',
	hcDark: '#2ea04350',
	hcLight: '#2ea04330',
}, localize('nyrve.addedLineBackground', "Background color for lines added by the Nyrve agent."));

export const nyrveRemovedLineBackground = registerColor('nyrve.removedLineBackground', {
	dark: '#f8514930',
	light: '#f8514920',
	hcDark: '#f8514950',
	hcLight: '#f8514930',
}, localize('nyrve.removedLineBackground', "Background color for lines removed by the Nyrve agent."));

export const nyrveAcceptedLineBackground = registerColor('nyrve.acceptedLineBackground', {
	dark: '#2ea04315',
	light: '#2ea04310',
	hcDark: '#2ea04320',
	hcLight: '#2ea04315',
}, localize('nyrve.acceptedLineBackground', "Fading highlight for recently accepted agent changes."));

export const nyrveGutterAdded = registerColor('nyrve.gutterAdded', {
	dark: '#2ea043',
	light: '#2ea043',
	hcDark: '#2ea043',
	hcLight: '#2ea043',
}, localize('nyrve.gutterAdded', "Gutter decoration color for agent-added lines."));

const nyrveOverviewRulerAdded = registerColor('nyrve.overviewRulerAdded', {
	dark: '#2ea043',
	light: '#2ea043',
	hcDark: '#2ea043',
	hcLight: '#2ea043',
}, localize('nyrve.overviewRulerAdded', "Overview ruler color for agent-added lines."));

/**
 * Editor contribution that manages decorations for Nyrve agent changes:
 * - Gutter annotations on pending hunks
 * - Line highlight backgrounds
 * - Minimap/overview ruler coloring
 * - Fade-out animation after hunk acceptance
 */
export class NyrveChangeDecorationsContribution extends Disposable implements IEditorContribution {

	static readonly ID = 'nyrve.changeDecorationsContribution';

	private _decorationsCollection: IEditorDecorationsCollection | undefined;
	private readonly _fadeTimers = this._register(new DisposableStore());

	constructor(
		private readonly _editor: ICodeEditor,
		@INyrveDiffService private readonly _diffService: INyrveDiffService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService _logService: ILogService,
	) {
		super();

		this._register(this._diffService.onDidProposeChangeSet(() => this._updateDecorations()));
		this._register(this._diffService.onDidChangeHunkStatus(hunk => {
			this._updateDecorations();
			if (hunk.status === HunkStatus.Accepted) {
				this._startFadeHighlight(hunk.startLine, hunk.endLine);
			}
		}));
		this._register(this._diffService.onDidChangeStatus(() => this._updateDecorations()));
		this._register(this._editor.onDidChangeModel(() => this._updateDecorations()));
	}

	private _updateDecorations(): void {
		const showGutter = this._configurationService.getValue<boolean>('nyrve.diff.showGutterDecorations') ?? true;
		const changeSet = this._diffService.getActiveChangeSet();
		const model = this._editor.getModel();

		if (!changeSet || !model) {
			this._clearDecorations();
			return;
		}

		const filePath = model.uri.fsPath;
		const file = changeSet.files.find(f => f.filePath === filePath);
		if (!file) {
			this._clearDecorations();
			return;
		}

		const decorations: IModelDeltaDecoration[] = [];

		for (const hunk of file.hunks) {
			if (hunk.status !== HunkStatus.Pending) {
				continue;
			}

			const startLine = Math.max(1, hunk.startLine);
			const endLine = Math.min(model.getLineCount(), hunk.endLine);
			const range = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));

			decorations.push({
				range,
				options: {
					description: 'nyrve-pending-change',
					isWholeLine: true,
					className: 'nyrve-pending-change-line',
					linesDecorationsClassName: showGutter ? 'nyrve-gutter-pending' : undefined,
					linesDecorationsTooltip: localize('nyrve.gutter.pending', "Nyrve: Pending change"),
					overviewRuler: {
						color: themeColorFromId(nyrveOverviewRulerAdded),
						position: OverviewRulerLane.Left,
					},
					minimap: {
						color: themeColorFromId(nyrveOverviewRulerAdded),
						position: 1, // MinimapPosition.Inline
					},
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				},
			});
		}

		if (!this._decorationsCollection) {
			this._decorationsCollection = this._editor.createDecorationsCollection(decorations);
		} else {
			this._decorationsCollection.set(decorations);
		}
	}

	/**
	 * Show a fading highlight on recently accepted lines.
	 * The highlight duration is configurable via `nyrve.diff.highlightDuration`.
	 */
	private _startFadeHighlight(startLine: number, endLine: number): void {
		const durationSec = this._configurationService.getValue<number>('nyrve.diff.highlightDuration') ?? 30;
		if (durationSec <= 0) {
			return;
		}

		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const safeEnd = Math.min(model.getLineCount(), endLine);
		const range = new Range(startLine, 1, safeEnd, model.getLineMaxColumn(safeEnd));

		const fadeCollection = this._editor.createDecorationsCollection([{
			range,
			options: {
				description: 'nyrve-accepted-fade',
				isWholeLine: true,
				className: 'nyrve-accepted-fade-line',
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			},
		}]);

		const timer = setTimeout(() => {
			fadeCollection.set([]);
		}, durationSec * 1000);

		this._fadeTimers.add({
			dispose: () => {
				clearTimeout(timer);
				fadeCollection.set([]);
			}
		});
	}

	private _clearDecorations(): void {
		this._decorationsCollection?.set([]);
	}
}

registerEditorContribution(NyrveChangeDecorationsContribution.ID, NyrveChangeDecorationsContribution, 0 /* EditorContributionInstantiation.Eager */);
