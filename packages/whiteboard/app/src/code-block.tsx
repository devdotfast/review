import { isNumberValue, isStringValue } from "@dev.fast/whiteboard-protocol";
import {
  type ShjLanguage,
  type ShjToken,
  tokenize,
} from "@speed-highlight/core";
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  isValidElement,
  useEffect,
  useState,
} from "react";

import { copyText } from "./copy-text";
import { DiagramHeader } from "./diagram-header";
import { CheckIcon, CopyIcon } from "./icons";

export interface RenderedCodeBlockProps extends ComponentProps<"pre"> {
  code: string;
  language?: string | null;
  /** Header title; a fenced markdown block has none. */
  caption?: string;
  /** Ghost line numbers in a sticky gutter; off for fenced markdown. */
  lineNumbers?: boolean;
  codeClassName?: string;
  codeAttributes?: Record<string, string>;
}

/** A code figure: the same header as the other figures (language badge,
 * caption, line count, copy), then the highlighted code. */
export function RenderedCodeBlock({
  code,
  language,
  caption,
  lineNumbers = false,
  codeClassName,
  codeAttributes,
  className,
  ...props
}: RenderedCodeBlockProps): ReactElement {
  const normalizedLanguage = normalizeMarkdownCodeLanguage(language ?? "");

  const [highlightedTokens, setHighlightedTokens] = useState<
    HighlightedToken[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    if (!normalizedLanguage) {
      setHighlightedTokens(null);

      return;
    }

    const tokens: HighlightedToken[] = [];
    tokenize(code, normalizedLanguage, (text, token) => {
      tokens.push({ text, token });
    })
      .then(() => {
        if (!cancelled) setHighlightedTokens(tokens);
      })
      .catch(() => {
        if (!cancelled) setHighlightedTokens(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, normalizedLanguage]);

  const figureClassName = ["rendered-code-block", className]
    .filter(Boolean)
    .join(" ");

  const displayLanguage = normalizedLanguage ?? language?.trim() ?? undefined;
  const lineCount = countLines(code);

  return (
    <figure className={figureClassName} data-language={displayLanguage}>
      <DiagramHeader
        kind={displayLanguage || "code"}
        title={caption}
        meta={`${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
        action={<CopyCodeButton code={code} />}
      />
      <pre {...props} className="rendered-code-body">
        {lineNumbers && (
          <span aria-hidden="true" className="rendered-code-gutter">
            {Array.from({ length: lineCount }, (_, index) => index + 1).join(
              "\n",
            )}
          </span>
        )}
        <code {...codeAttributes} className={codeClassName}>
          {normalizedLanguage && highlightedTokens
            ? highlightedTokens.map((item, index) =>
                item.token ? (
                  <span className={`shj-syn-${item.token}`} key={index}>
                    {item.text}
                  </span>
                ) : (
                  item.text
                ),
              )
            : code}
        </code>
      </pre>
    </figure>
  );
}

/** A trailing newline ends the last line rather than starting an empty one. */
function countLines(code: string): number {
  const lines = code.split("\n");

  return lines.length > 1 && lines.at(-1) === ""
    ? lines.length - 1
    : lines.length;
}

const COPIED_FOR_MS = 1200;

function CopyCodeButton({ code }: { code: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS);

    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="rendered-code-copy"
      aria-label="Copy"
      title="Copy"
      data-copied={copied ? "" : undefined}
      onClick={() => {
        // The workbench denies DOM clipboard requests; copyText falls back to
        // execCommand and reports whether anything was copied.
        void copyText(code).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

interface HighlightedToken {
  text: string;
  token: ShjToken | undefined;
}

export function MarkdownCodeBlock({
  children,
  className,
  ...props
}: ComponentProps<"pre">): ReactElement {
  const codeElement = isValidElement<ComponentProps<"code">>(children)
    ? children
    : null;

  const codeClassName = codeElement?.props.className ?? "";

  const language = codeClassName
    .split(/\s+/)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);

  const code = reactTextContent(codeElement?.props.children ?? children);

  const preClassName = ["markdown-code-block", className]
    .filter(Boolean)
    .join(" ");

  return (
    <RenderedCodeBlock
      {...props}
      className={preClassName}
      code={code}
      language={language}
      codeClassName={codeClassName}
    />
  );
}

function normalizeMarkdownCodeLanguage(language: string): ShjLanguage | null {
  const normalized = language.trim().toLowerCase();

  switch (normalized) {
    case "asm":
    case "bash":
    case "bf":
    case "c":
    case "css":
    case "csv":
    case "diff":
    case "docker":
    case "git":
    case "go":
    case "html":
    case "http":
    case "ini":
    case "java":
    case "js":
    case "jsdoc":
    case "json":
    case "leanpub-md":
    case "log":
    case "lua":
    case "make":
    case "md":
    case "pl":
    case "plain":
    case "py":
    case "regex":
    case "rs":
    case "sql":
    case "todo":
    case "toml":
    case "ts":
    case "uri":
    case "xml":
    case "yaml":
      return normalized;
    case "javascript":
    case "jsx":
      return "js";
    case "typescript":
    case "tsx":
      return "ts";
    case "python":
      return "py";
    case "rust":
      return "rs";
    case "markdown":
    case "mdx":
      return "md";
    case "shell":
    case "sh":
    case "zsh":
      return "bash";
    case "yml":
      return "yaml";
    case "text":
      return "plain";
    default:
      return null;
  }
}

function reactTextContent(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(reactTextContent).join("");

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return reactTextContent(node.props.children);
  }

  return isReactText(node) ? String(node) : "";
}

/** Text React renders verbatim; booleans, null and undefined render nothing. */
function isReactText(node: ReactNode): node is string | number {
  return isStringValue(node) || isNumberValue(node);
}
