import { isNumberValue, isStringValue } from "@dev.fast/review-protocol";
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

export interface RenderedCodeBlockProps extends ComponentProps<"pre"> {
  code: string;
  language?: string | null;
  codeClassName?: string;
  codeAttributes?: Record<string, string>;
  lineGutter?: ReactNode;
}

export function RenderedCodeBlock({
  code,
  language,
  codeClassName,
  codeAttributes,
  lineGutter,
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

  const preClassName = ["rendered-code-block", className]
    .filter(Boolean)
    .join(" ");
  const displayLanguage = normalizedLanguage ?? language?.trim() ?? undefined;

  if (normalizedLanguage && highlightedTokens) {
    return (
      <pre {...props} className={preClassName} data-language={displayLanguage}>
        {lineGutter}
        <code {...codeAttributes} className={codeClassName}>
          {highlightedTokens.map((item, index) =>
            item.token ? (
              <span className={`shj-syn-${item.token}`} key={index}>
                {item.text}
              </span>
            ) : (
              item.text
            ),
          )}
        </code>
      </pre>
    );
  }

  return (
    <pre {...props} className={preClassName} data-language={displayLanguage}>
      {lineGutter}
      <code {...codeAttributes} className={codeClassName}>
        {code}
      </code>
    </pre>
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
  switch (language.trim().toLowerCase()) {
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
      return language.trim().toLowerCase() as ShjLanguage;
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
