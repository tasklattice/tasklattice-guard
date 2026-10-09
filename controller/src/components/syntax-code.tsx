import { useMemo, type ReactNode } from "react";
import { refractor, type Syntax } from "refractor/core";
import bash from "refractor/bash";
import http from "refractor/http";
import json from "refractor/json";
import yaml from "refractor/yaml";
import { cn } from "@/lib/utils";
import "./syntax-code.css";

refractor.register(json);
refractor.register(yaml);
refractor.register(bash);
refractor.register(http);
// Fence names used by the documentation; JSON Lines tokenizes as JSON.
refractor.alias({ bash: ["sh", "shell", "zsh"], json: ["jsonl"] });

// Colang's generated flow statements are not part of Prism's bundled grammars.
// Tokenize for display only; compilation and validation belong to the Runner.
const colang: Syntax = Object.assign((prism: typeof refractor) => {
  prism.languages.colang = {
    comment: /#.*/,
    string: {
      pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/,
      greedy: true,
    },
    keyword: {
      pattern: /(^[\t ]*)(?:define(?:[\t ]+(?:bot|user|flow|subflow))?|flow|subflow|do|execute|await|match|send|start|stop|activate|deactivate|abort|finish|if|else|elif|when|while|for|return|break|continue|pass|import|from|global|set|bot|user)\b/m,
      lookbehind: true,
    },
    boolean: /\b(?:True|False|None|true|false|null)\b/,
    variable: /\$[a-zA-Z_]\w*/,
    function: { pattern: /(\b(?:execute|await)[\t ]+)[a-zA-Z_]\w*/, lookbehind: true },
    number: /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i,
    operator: /\b(?:and|or|not|is|in)\b|[+*/%=!<>-]=?/,
    punctuation: /[{}[\]():,.]/,
  };
}, { displayName: "colang" });
refractor.register(colang);

type SyntaxNode = ReturnType<typeof refractor.highlight>["children"][number];

function renderToken(node: SyntaxNode, index: number): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  const classes = node.properties.className;
  // Render text and spans only, never HTML supplied by the file being viewed.
  return <span key={index} className={Array.isArray(classes) ? classes.join(" ") : undefined}>{node.children.map(renderToken)}</span>;
}

export function SyntaxCode({ content, language, label, className }: {
  content: string;
  language: string;
  label: string;
  className?: string;
}) {
  const normalizedLanguage = language.toLowerCase();
  const tokens = useMemo(() => {
    if (!refractor.registered(normalizedLanguage)) return null;
    return refractor.highlight(content, normalizedLanguage).children;
  }, [content, normalizedLanguage]);

  return <pre role="region" aria-label={label} tabIndex={0} data-language={normalizedLanguage}
    className={cn("syntax-code overflow-auto overscroll-contain bg-muted/10 p-4 font-mono text-xs leading-5 whitespace-pre focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", className)}>
    <code>{tokens ? tokens.map(renderToken) : content}</code>
  </pre>;
}
