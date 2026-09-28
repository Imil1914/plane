// Test support (env node, no DOM): renders hook-free components by calling them and lists the host elements
// (div, button, input…) in document order, so a test can press a button by calling its onClick.
import { isValidElement, type ReactElement, type ReactNode } from "react";

type TProps = Record<string, unknown> & { children?: ReactNode };
export type THostElement = { type: string; props: TProps };

function expand(element: ReactElement<TProps>): ReactNode {
  return (element.type as (props: TProps) => ReactNode)(element.props);
}

export function hostElements(node: ReactNode): THostElement[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => hostElements(child));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<TProps>;
  if (typeof element.type === "function") return hostElements(expand(element));
  // Fragments and lucide icons (forwardRef objects) carry no host element of their own worth pressing.
  if (typeof element.type !== "string") return hostElements(element.props.children);
  return [{ type: element.type, props: element.props }, ...hostElements(element.props.children)];
}

export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child: ReactNode) => textOf(child)).join("");
  if (!isValidElement(node)) return "";
  const element = node as ReactElement<TProps>;
  return textOf(typeof element.type === "function" ? expand(element) : element.props.children);
}

/** Buttons whose accessible name (aria-label, else the text) is `name`. */
export function buttonsNamed(node: ReactNode, name: string): THostElement[] {
  return hostElements(node).filter(
    (element) =>
      element.type === "button" && (element.props["aria-label"] ?? textOf(element.props.children).trim()) === name
  );
}

export function press(button: THostElement | undefined) {
  if (!button) throw new Error("No such button");
  if (button.props.disabled) throw new Error("The button is disabled");
  (button.props.onClick as () => void)();
}
