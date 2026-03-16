/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../vs/base/common/cancellation.js';
import { URI } from '../../vs/base/common/uri.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IModelService } from '../../vs/editor/common/services/model.js';
import { ILanguageFeaturesService } from '../../vs/editor/common/services/languageFeatures.js';
import { DocumentSymbol, SymbolKind } from '../../vs/editor/common/languages.js';

// --- Types ---

export const enum NyrveSymbolKind {
	Function = 'function',
	Class = 'class',
	Method = 'method',
	Variable = 'variable',
	Constant = 'constant',
	Interface = 'interface',
	Enum = 'enum',
	Type = 'type',
	Property = 'property',
	Constructor = 'constructor',
	Module = 'module',
	Other = 'other',
}

export interface NyrveSymbol {
	readonly name: string;
	readonly kind: NyrveSymbolKind;
	readonly filePath: string;
	readonly lineStart: number;
	readonly lineEnd: number;
	readonly signature: string;
	readonly containerName: string | undefined;
}

export interface NyrveFileSymbols {
	readonly filePath: string;
	readonly language: string | undefined;
	readonly symbols: readonly NyrveSymbol[];
}

// --- Service Interface ---

export const INyrveSymbolExtractor = createDecorator<INyrveSymbolExtractor>('nyrveSymbolExtractor');

export interface INyrveSymbolExtractor {
	readonly _serviceBrand: undefined;

	/** Extract symbols from a file using VS Code's language features. */
	extractSymbols(filePath: string): Promise<NyrveFileSymbols>;

	/** Extract symbols from all open models. */
	extractAllOpenSymbols(): Promise<NyrveFileSymbols[]>;
}

// --- Service Implementation ---

export class NyrveSymbolExtractor extends Disposable implements INyrveSymbolExtractor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async extractSymbols(filePath: string): Promise<NyrveFileSymbols> {
		const uri = URI.file(filePath);
		const model = this.modelService.getModel(uri);

		if (!model) {
			return { filePath, language: undefined, symbols: [] };
		}

		const providers = this.languageFeaturesService.documentSymbolProvider.ordered(model);
		if (providers.length === 0) {
			return { filePath, language: model.getLanguageId(), symbols: [] };
		}

		try {
			const documentSymbols = await providers[0].provideDocumentSymbols(model, CancellationToken.None);
			if (!documentSymbols) {
				return { filePath, language: model.getLanguageId(), symbols: [] };
			}

			const symbols = this._flattenSymbols(filePath, documentSymbols, undefined);
			this.logService.trace(`[Nyrve] Extracted ${symbols.length} symbols from ${filePath}`);

			return {
				filePath,
				language: model.getLanguageId(),
				symbols,
			};
		} catch (e) {
			this.logService.warn(`[Nyrve] Symbol extraction failed for ${filePath}: ${e}`);
			return { filePath, language: model.getLanguageId(), symbols: [] };
		}
	}

	async extractAllOpenSymbols(): Promise<NyrveFileSymbols[]> {
		const models = this.modelService.getModels();
		const results: NyrveFileSymbols[] = [];

		for (const model of models) {
			const filePath = model.uri.fsPath;
			const fileSymbols = await this.extractSymbols(filePath);
			if (fileSymbols.symbols.length > 0) {
				results.push(fileSymbols);
			}
		}

		return results;
	}

	private _flattenSymbols(filePath: string, symbols: DocumentSymbol[], containerName: string | undefined): NyrveSymbol[] {
		const result: NyrveSymbol[] = [];

		for (const sym of symbols) {
			result.push({
				name: sym.name,
				kind: this._mapSymbolKind(sym.kind),
				filePath,
				lineStart: sym.range.startLineNumber,
				lineEnd: sym.range.endLineNumber,
				signature: sym.detail || sym.name,
				containerName,
			});

			// Recurse into children
			if (sym.children && sym.children.length > 0) {
				result.push(...this._flattenSymbols(filePath, sym.children, sym.name));
			}
		}

		return result;
	}

	private _mapSymbolKind(kind: SymbolKind): NyrveSymbolKind {
		switch (kind) {
			case SymbolKind.Function: return NyrveSymbolKind.Function;
			case SymbolKind.Class: return NyrveSymbolKind.Class;
			case SymbolKind.Method: return NyrveSymbolKind.Method;
			case SymbolKind.Variable: return NyrveSymbolKind.Variable;
			case SymbolKind.Constant: return NyrveSymbolKind.Constant;
			case SymbolKind.Interface: return NyrveSymbolKind.Interface;
			case SymbolKind.Enum: return NyrveSymbolKind.Enum;
			case SymbolKind.TypeParameter: return NyrveSymbolKind.Type;
			case SymbolKind.Property: return NyrveSymbolKind.Property;
			case SymbolKind.Constructor: return NyrveSymbolKind.Constructor;
			case SymbolKind.Module:
			case SymbolKind.Namespace:
			case SymbolKind.Package: return NyrveSymbolKind.Module;
			default: return NyrveSymbolKind.Other;
		}
	}
}

registerSingleton(INyrveSymbolExtractor, NyrveSymbolExtractor, InstantiationType.Delayed);
