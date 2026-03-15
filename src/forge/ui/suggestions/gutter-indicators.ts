/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { ICodeEditor } from '../../../vs/editor/browser/editorBrowser.js';
import { registerEditorContribution } from '../../../vs/editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../vs/editor/common/editorCommon.js';
import { IModelDecorationOptions, TrackedRangeStickiness } from '../../../vs/editor/common/model.js';
import { registerColor } from '../../../vs/platform/theme/common/colorRegistry.js';
import { Color, RGBA } from '../../../vs/base/common/color.js';
import { IForgeBackgroundAgent, BackgroundSuggestion } from '../../agent/background-agent.js';

// --- Theme Colors ---

export const forgeSuggestionGutterInfo = registerColor('forge.suggestionGutterInfo', {
	dark: new Color(new RGBA(100, 149, 237, 0.8)),
	light: new Color(new RGBA(70, 130, 180, 0.8)),
	hcDark: new Color(new RGBA(100, 149, 237, 1.0)),
	hcLight: new Color(new RGBA(70, 130, 180, 1.0)),
}, 'Gutter indicator color for info-level background agent suggestions.');

export const forgeSuggestionGutterWarning = registerColor('forge.suggestionGutterWarning', {
	dark: new Color(new RGBA(255, 193, 7, 0.8)),
	light: new Color(new RGBA(255, 160, 0, 0.8)),
	hcDark: new Color(new RGBA(255, 193, 7, 1.0)),
	hcLight: new Color(new RGBA(255, 160, 0, 1.0)),
}, 'Gutter indicator color for warning-level background agent suggestions.');

export const forgeSuggestionGutterCritical = registerColor('forge.suggestionGutterCritical', {
	dark: new Color(new RGBA(244, 67, 54, 0.8)),
	light: new Color(new RGBA(211, 47, 47, 0.8)),
	hcDark: new Color(new RGBA(244, 67, 54, 1.0)),
	hcLight: new Color(new RGBA(211, 47, 47, 1.0)),
}, 'Gutter indicator color for critical-level background agent suggestions.');

// --- Decoration Options ---

const INFO_DECORATION: IModelDecorationOptions = {
	description: 'forge-suggestion-info',
	glyphMarginClassName: 'forge-suggestion-glyph forge-suggestion-info',
	glyphMarginHoverMessage: { value: 'Forge: Info suggestion' },
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
};

const WARNING_DECORATION: IModelDecorationOptions = {
	description: 'forge-suggestion-warning',
	glyphMarginClassName: 'forge-suggestion-glyph forge-suggestion-warning',
	glyphMarginHoverMessage: { value: 'Forge: Warning' },
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
};

const CRITICAL_DECORATION: IModelDecorationOptions = {
	description: 'forge-suggestion-critical',
	glyphMarginClassName: 'forge-suggestion-glyph forge-suggestion-critical',
	glyphMarginHoverMessage: { value: 'Forge: Critical issue' },
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
};

// --- Editor Contribution ---

export class ForgeSuggestionGutterContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'forge.suggestionGutterContribution';

	private _decorationsCollection = this._editor.createDecorationsCollection();

	constructor(
		private readonly _editor: ICodeEditor,
		@IForgeBackgroundAgent private readonly backgroundAgent: IForgeBackgroundAgent,
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

registerEditorContribution(ForgeSuggestionGutterContribution.ID, ForgeSuggestionGutterContribution, 0);
