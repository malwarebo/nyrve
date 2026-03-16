/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IEditorService } from '../../vs/workbench/services/editor/common/editorService.js';
import { IModelService } from '../../vs/editor/common/services/model.js';
import { IMarkerService, MarkerSeverity } from '../../vs/platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { ICodeEditor } from '../../vs/editor/browser/editorBrowser.js';

// --- Types ---

export interface EditorState {
	readonly activeFilePath: string | undefined;
	readonly activeFileLanguage: string | undefined;
	readonly cursorPosition: { readonly line: number; readonly column: number } | undefined;
	readonly selection: {
		readonly startLine: number;
		readonly startColumn: number;
		readonly endLine: number;
		readonly endColumn: number;
	} | undefined;
	readonly selectedText: string | undefined;
	readonly openTabs: readonly string[];
	readonly diagnostics: readonly EditorDiagnostic[];
	readonly gitBranch: string | undefined;
	readonly projectRoot: string;
}

export interface EditorDiagnostic {
	readonly filePath: string;
	readonly line: number;
	readonly column: number;
	readonly severity: 'error' | 'warning' | 'info' | 'hint';
	readonly message: string;
	readonly source: string | undefined;
}

// --- Service Interface ---

export const INyrveEditorBridge = createDecorator<INyrveEditorBridge>('nyrveEditorBridge');

export interface INyrveEditorBridge {
	readonly _serviceBrand: undefined;

	/** Fires when the active editor changes. */
	readonly onDidChangeActiveEditor: Event<void>;

	/** Get a snapshot of the current editor state. */
	getEditorState(): EditorState;

	/** Get the content of a file by URI path. */
	getFileContent(filePath: string): string | undefined;

	/** Get the content of the currently active file. */
	getActiveFileContent(): string | undefined;

	/** Get all diagnostics, optionally filtered by severity. */
	getDiagnostics(minSeverity?: 'error' | 'warning' | 'info' | 'hint'): readonly EditorDiagnostic[];

	/** Get diagnostics for a specific file. */
	getFileDiagnostics(filePath: string): readonly EditorDiagnostic[];
}

// --- Service Implementation ---

export class NyrveEditorBridge extends Disposable implements INyrveEditorBridge {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveEditor = this._register(new Emitter<void>());
	readonly onDidChangeActiveEditor: Event<void> = this._onDidChangeActiveEditor.event;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService _logService: ILogService,
	) {
		super();

		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._onDidChangeActiveEditor.fire();
		}));
	}

	getEditorState(): EditorState {
		const editor = this._getActiveCodeEditor();
		const model = editor?.getModel();
		const position = editor?.getPosition();
		const selection = editor?.getSelection();
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri.fsPath ?? '';

		let selectedText: string | undefined;
		if (selection && model && !selection.isEmpty()) {
			selectedText = model.getValueInRange(selection);
		}

		const openTabs: string[] = [];
		for (const editorInput of this.editorService.editors) {
			const uri = editorInput.resource;
			if (uri) {
				openTabs.push(uri.fsPath);
			}
		}

		return {
			activeFilePath: model?.uri.fsPath,
			activeFileLanguage: model?.getLanguageId(),
			cursorPosition: position ? { line: position.lineNumber, column: position.column } : undefined,
			selection: selection && !selection.isEmpty() ? {
				startLine: selection.startLineNumber,
				startColumn: selection.startColumn,
				endLine: selection.endLineNumber,
				endColumn: selection.endColumn,
			} : undefined,
			selectedText,
			openTabs,
			diagnostics: this.getDiagnostics(),
			gitBranch: undefined, // Will be populated in Phase 5 via git integration
			projectRoot,
		};
	}

	getFileContent(filePath: string): string | undefined {
		const models = this.modelService.getModels();
		for (const model of models) {
			if (model.uri.fsPath === filePath) {
				return model.getValue();
			}
		}
		return undefined;
	}

	getActiveFileContent(): string | undefined {
		const editor = this._getActiveCodeEditor();
		return editor?.getModel()?.getValue();
	}

	getDiagnostics(minSeverity?: 'error' | 'warning' | 'info' | 'hint'): readonly EditorDiagnostic[] {
		const severityThreshold = this._toMarkerSeverity(minSeverity ?? 'hint');
		const markers = this.markerService.read();
		return markers
			.filter(m => m.severity >= severityThreshold)
			.map(m => ({
				filePath: m.resource.fsPath,
				line: m.startLineNumber,
				column: m.startColumn,
				severity: this._fromMarkerSeverity(m.severity),
				message: m.message,
				source: m.source,
			}));
	}

	getFileDiagnostics(filePath: string): readonly EditorDiagnostic[] {
		return this.getDiagnostics().filter(d => d.filePath === filePath);
	}

	private _getActiveCodeEditor(): ICodeEditor | undefined {
		const control = this.editorService.activeTextEditorControl;
		if (control && 'getModel' in control && 'getPosition' in control) {
			return control as ICodeEditor;
		}
		return undefined;
	}

	private _toMarkerSeverity(severity: 'error' | 'warning' | 'info' | 'hint'): MarkerSeverity {
		switch (severity) {
			case 'error': return MarkerSeverity.Error;
			case 'warning': return MarkerSeverity.Warning;
			case 'info': return MarkerSeverity.Info;
			case 'hint': return MarkerSeverity.Hint;
		}
	}

	private _fromMarkerSeverity(severity: MarkerSeverity): 'error' | 'warning' | 'info' | 'hint' {
		switch (severity) {
			case MarkerSeverity.Error: return 'error';
			case MarkerSeverity.Warning: return 'warning';
			case MarkerSeverity.Info: return 'info';
			default: return 'hint';
		}
	}
}

registerSingleton(INyrveEditorBridge, NyrveEditorBridge, InstantiationType.Delayed);
