/** The owned parser boundary. No Markdown, HAST, ESTree, or parser objects
 * escape this interface. Offsets address the original UTF-16 source text. */
export interface SourceSpan {
  start: number;
  end: number;
}

export interface AuthoredSource {
  value: string;
  span: SourceSpan;
}

export type DocumentAttribute =
  | {
      kind: "literal";
      name: string;
      value: string | number | boolean;
      span?: SourceSpan;
    }
  | { kind: "expression"; name: string; expression: number; span?: SourceSpan }
  | { kind: "spread"; expression: number; span?: SourceSpan };

export type DocumentSyntaxNode =
  | { kind: "text"; value: string; span?: SourceSpan }
  | { kind: "expression"; expression: number; span?: SourceSpan }
  | {
      kind: "element";
      name: string | null;
      attributes: DocumentAttribute[];
      children: DocumentSyntaxNode[];
      span?: SourceSpan;
    };

export interface DocumentSyntax {
  title: string;
  modules: AuthoredSource[];
  expressions: AuthoredSource[];
  bindings: string[];
  /** Exported software model declarations, in authored order. */
  declaredModelNames?: string[];
  body: DocumentSyntaxNode[];
}

export type DocumentParser = (source: string) => Promise<DocumentSyntax>;

export class DocumentParseError extends Error {
  override readonly name = "DocumentParseError";
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
  }
}
