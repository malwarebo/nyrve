/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { ICodeEditor } from '../../../vs/editor/browser/editorBrowser.js';
import { registerEditorContribution } from '../../../vs/editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../vs/editor/common/editorCommon.js';
import { IModelDecorationOptions, TrackedRangeStickiness } from '../../../vs/editor/common/model.js';
import { registerColor } from '../../../vs/platform/theme/common/colorRegistry.js';
import { Color, RGBA } from '../../../vs/base/common/color.js';
import { INyrveBackgroundAgent, BackgroundSuggestion } from '../../agent/background-agent.js';

// --- Theme Colors ---

export const nyrveSuggestionGutterInfo = registerColor('nyrve.suggestionGutterInfo', {
	dark: new Color(new RGBA(100, 149, 237, 0.8)),
	light: new Color(new RGBA(70, 130, 180, 0.8)),
	hcDark: new Color(new RGBA(100, 149, 237, 1.0)),
	hcLight: new Color(new RGBA(70, 130, 180, 1.0)),
}, 'Gutter indicator color for info-level background agent suggestions.');

export const nyrveSuggestionGutterWarning = registerColor('nyrve.suggestionGutterWarning', {
	dark: new Color(new RGBA(255, 193, 7, 0.8)),
	light: new Color(new RGBA(255, 160, 0, 0.8)),
	hcDark: new Color(new RGBA(255, 193, 7, 1.0)),
	hcLight: new Color(new RGBA(255, 160, 0, 1.0)),
}, 'Gutter indicator color for warning-level background agent suggestions.');

export const nyrveSuggestionGutterCritical = registerColor('nyrve.suggestionGutterCritical', {
	dark: new Color(new RGBA(244, 67, 54, 0.8)),
	light: new Color(new RGBA(211, 47, 47, 0.8)),
	hcDark: new Color(new RGBA(244, 67, 54, 1.0)),
	hcLight: new Color(new RGBA(211, 47, 47, 1.0)),
}, 'Gutter indicator color for critical-level background agent suggestions.');

// --- Decoration Options ---

const INFO_DECORATION: IModelDecorationOptions = {
	description: 'nyrve-suggestion-info',
	glyphMarginClassName: 'nyrve-suggestion-glyph nyrve-suggestion-info',
	glyphMarginHoverMessage: { value: 'Nyrve: Info suggestion' },
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
};

const WARNING_DECORATION: IModelDecorationOptions = {
	description: 'nyrve-suggestion-warning',
	glyphMarginClassName: 'nyrve-suggestion-glyph nyrve-suggestion-warning',
	glyphMarginHoverMessage: { value: 'Nyrve: Warning' },
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
};

const CRITICAL_DECORATION: IModelDecorationOptions = {
	description: 'nyrve-suggestion-critical',
	glyphMarginClassName: 'nyrve-suggestion-glyph nyrve-suggestion-critical',
	glyphMarginHoverMessage: { value: 'Nyrve: Critical issue' },
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
};

// --- Editor Contribution ---

export class NyrveSuggestionGutterContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'nyrve.suggestionGutterContribution';

	private _decorationsCollection = this._editor.createDecorationsCollection();

	constructor(
		private readonly _editor: ICodeEditor,
		@INyrveBackgroundAgent private readonly backgroundAgent: INyrveBackgroundAgent,
	) {
		super();

		this._register(this.backgroundAgent.onDidAddSuggestion(() => this._updateDecorations()));
		this._register(this.backgroundAgent.onDidRemoveSuggestion(() => this._updateDecorations()));
		this._register(this._editor.onDidChangeModel(() => this._updateDecorations()));

		this._updateDecorations();
	}

	private _updateDecorations(): void {
		const model = this._editor.getModel();
		if (!model) {
			this._decorationsCollection.clear();
			return;
		}

		const filePath = model.uri.fsPath;
		const suggestions = this.backgroundAgent.getFileSuggestions(filePath);

		const decorations = suggestions
			.filter(s => !s.dismissed)
			.map(s => ({
				range: {
					startLineNumber: s.lineRange.start,
					startColumn: 1,
					endLineNumber: s.lineRange.end,
					endColumn: 1,
				},
				options: this._getDecoration(s),
			}));

		this._decorationsCollection.set(decorations);
	}

	private _getDecoration(suggestion: BackgroundSuggestion): IModelDecorationOptions {
		switch (suggestion.severity) {
			case 'critical': return CRITICAL_DECORATION;
			case 'warning': return WARNING_DECORATION;
			default: return INFO_DECORATION;
		}
	}
}

registerEditorContribution(NyrveSuggestionGutterContribution.ID, NyrveSuggestionGutterContribution, 0);
