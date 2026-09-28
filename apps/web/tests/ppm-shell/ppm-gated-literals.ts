/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R: an AST check for English leftovers. A string/JSX/template literal that contains one of the phrases may stay
// in the source only as the upstream fallback that the Russian PPM interface never shows:
//   ppmText("ui.key", <upstream>)                  (hooks/use-ppm-text)
//   ppmServerError(error, {…}, <upstream toast>) / ppmSubMessage(k1, k2, <upstream>)
//   <FLAG> ? <PPM> : <upstream>                    where <FLAG> is exactly a shell flag identifier or an
//                                                  isPpmShellEnabled(...) call — no `!`, `&&`, `||` or parentheses.
// `isPpmRu` (hooks/use-ppm-text: the PPM shell AND the Russian interface) counts as a flag: in the Russian PPM
// interface it is true, so its false branch is never shown there.
// The action name passed to `handleOptionalAction(fn, <name>)` is not interface text either: it only fills that
// helper's own English developer-error toast («<name> action is not implemented.», a menu item without a handler).
// Anything else is a leftover the Russian interface would show.
import { readFileSync } from "node:fs";
import ts from "typescript";

const FALLBACK_ARGUMENT: Record<string, number> = { ppmText: 1, ppmServerError: 2, ppmSubMessage: 2 };
const INTERNAL_ARGUMENT: Record<string, number> = { handleOptionalAction: 1 };
// Their first argument is a @ppm/brand key («ui.property.module»), not text.
const KEY_FIRST_ARGUMENT = new Set(["ppmText", "ppmT", "ppmCount", "ppmSubMessage"]);
const SHELL_FLAGS = new Set(["IS_PPM_SHELL_TEXT", "IS_PPM_SHELL_ENABLED", "isPpmShell", "isPpmRu"]);

/** Exactly a shell flag or an isPpmShellEnabled(...) call; `!flag`, `flag && x`, `flag || x`, `(flag)` do not count. */
export function isShellCondition(condition: ts.Expression): boolean {
  if (ts.isIdentifier(condition)) return SHELL_FLAGS.has(condition.text);
  return ts.isCallExpression(condition) && ts.isIdentifier(condition.expression)
    ? condition.expression.text === "isPpmShellEnabled"
    : false;
}

function isPpmKeyArgument(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  const callee = parent.expression.getText();
  if (!KEY_FIRST_ARGUMENT.has(callee)) return false;
  return parent.arguments[0] === node || (callee === "ppmSubMessage" && parent.arguments[1] === node);
}

function isUpstreamFallback(node: ts.Node): boolean {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression.getText();
      for (const index of [FALLBACK_ARGUMENT[callee], INTERNAL_ARGUMENT[callee]])
        if (index !== undefined && parent.arguments[index] === current) return true;
    }
    if (ts.isConditionalExpression(parent) && parent.whenFalse === current && isShellCondition(parent.condition))
      return true;
  }
  return false;
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxText(node)) return node.getText().replace(/\s+/g, " ");
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("…");
  return undefined;
}

/** Phrases found in the source at all (to prove a case still points at real code) and the ungated occurrences. */
export function scanPpmSource(source: string, phrases: string[], fileName = "sample.tsx") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const present = new Set<string>();
  const ungated: string[] = [];
  const visit = (node: ts.Node) => {
    // Module specifiers («@/hooks/store/use-module») and type-only syntax are not user-visible text.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    const text = isPpmKeyArgument(node) ? undefined : literalText(node);
    if (text) {
      for (const phrase of phrases) {
        if (!text.includes(phrase)) continue;
        present.add(phrase);
        if (!isUpstreamFallback(node)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          ungated.push(`${line + 1}: ${phrase}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { present: [...present], ungated };
}

export function scanPpmLiterals(file: URL, phrases: string[]): { present: string[]; ungated: string[] } {
  return scanPpmSource(readFileSync(file, "utf8"), phrases, file.pathname);
}

/** Attribute names of every `<tag …>` element in the file (to check both button labels of AlertModalCore). */
export function jsxAttributeNames(file: URL, tag: string): string[][] {
  const sourceFile = ts.createSourceFile(
    file.pathname,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const elements: string[][] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === tag)
      elements.push(
        node.attributes.properties.flatMap((property) => (ts.isJsxAttribute(property) ? [property.name.getText()] : []))
      );
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return elements;
}
