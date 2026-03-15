/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
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

export const enum ForgeSymbolKind {
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

export interface ForgeSymbol {
	readonly name: string;
	readonly kind: ForgeSymbolKind;
	readonly filePath: string;
	readonly lineStart: number;
	readonly lineEnd: number;
	readonly signature: string;
	readonly containerName: string | undefined;
}

export interface ForgeFileSymbols {
	readonly filePath: string;
	readonly language: string | undefined;
	readonly symbols: readonly ForgeSymbol[];
}

// --- Service Interface ---

export const IForgeSymbolExtractor = createDecorator<IForgeSymbolExtractor>('forgeSymbolExtractor');

export interface IForgeSymbolExtractor {
	readonly _serviceBrand: undefined;

	/** Extract symbols from a file using VS Code's language features. */
	extractSymbols(filePath: string): Promise<ForgeFileSymbols>;

	/** Extract symbols from all open models. */
	extractAllOpenSymbols(): Promise<ForgeFileSymbols[]>;
}

// --- Service Implementation ---

export class ForgeSymbolExtractor extends Disposable implements IForgeSymbolExtractor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async extractSymbols(filePath: string): Promise<ForgeFileSymbols> {
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
			this.logService.trace(`[Forge] Extracted ${symbols.length} symbols from ${filePath}`);

			return {
				filePath,
				language: model.getLanguageId(),
				symbols,
			};
		} catch (e) {
			this.logService.warn(`[Forge] Symbol extraction failed for ${filePath}: ${e}`);
			return { filePath, language: model.getLanguageId(), symbols: [] };
		}
	}

	async extractAllOpenSymbols(): Promise<ForgeFileSymbols[]> {
		const models = this.modelService.getModels();
		const results: ForgeFileSymbols[] = [];

		for (const model of models) {
			const filePath = model.uri.fsPath;
			const fileSymbols = await this.extractSymbols(filePath);
			if (fileSymbols.symbols.length > 0) {
				results.push(fileSymbols);
			}
		}

		return results;
	}

	private _flattenSymbols(filePath: string, symbols: DocumentSymbol[], containerName: string | undefined): ForgeSymbol[] {
		const result: ForgeSymbol[] = [];

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

	private _mapSymbolKind(kind: SymbolKind): ForgeSymbolKind {
		switch (kind) {
			case SymbolKind.Function: return ForgeSymbolKind.Function;
			case SymbolKind.Class: return ForgeSymbolKind.Class;
			case SymbolKind.Method: return ForgeSymbolKind.Method;
			case SymbolKind.Variable: return ForgeSymbolKind.Variable;
			case SymbolKind.Constant: return ForgeSymbolKind.Constant;
			case SymbolKind.Interface: return ForgeSymbolKind.Interface;
			case SymbolKind.Enum: return ForgeSymbolKind.Enum;
			case SymbolKind.TypeParameter: return ForgeSymbolKind.Type;
			case SymbolKind.Property: return ForgeSymbolKind.Property;
			case SymbolKind.Constructor: return ForgeSymbolKind.Constructor;
			case SymbolKind.Module:
			case SymbolKind.Namespace:
			case SymbolKind.Package: return ForgeSymbolKind.Module;
			default: return ForgeSymbolKind.Other;
		}
	}
}

registerSingleton(IForgeSymbolExtractor, ForgeSymbolExtractor, InstantiationType.Delayed);
