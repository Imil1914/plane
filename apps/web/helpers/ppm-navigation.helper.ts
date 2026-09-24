const PPM_HEADERLESS_PROJECT_ROUTE = /\/projects\/[^/]+\/(overview|brain|knowledge|code)(\/|$)/;

export function shouldShowTopNavSidebarToggle(input: {
  isPpmShell: boolean;
  sidebarCollapsed: boolean | undefined;
  pathname: string | null | undefined;
  workspaceSlug?: string;
}): boolean {
  const { isPpmShell, sidebarCollapsed, pathname, workspaceSlug } = input;
  if (!isPpmShell || !sidebarCollapsed || !pathname) return false;
  if (workspaceSlug && pathname.startsWith(`/${workspaceSlug}/notifications`)) return true;
  return PPM_HEADERLESS_PROJECT_ROUTE.test(pathname);
}
