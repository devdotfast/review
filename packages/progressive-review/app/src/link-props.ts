import type { ComponentPropsWithoutRef } from "react";

export function newTabLinkProps(
  href: string | undefined,
  props: ComponentPropsWithoutRef<"a"> = {},
): Pick<ComponentPropsWithoutRef<"a">, "target" | "rel"> {
  if (!href || href.startsWith("#")) return {};
  if (props.target && props.target !== "_blank") return {};
  return {
    target: props.target ?? "_blank",
    rel: appendRelTokens(props.rel, ["noopener", "noreferrer"]),
  };
}

function appendRelTokens(value: string | undefined, tokens: string[]): string {
  const relTokens = new Set((value ?? "").split(/\s+/).filter(Boolean));
  for (const token of tokens) relTokens.add(token);
  return [...relTokens].join(" ");
}
