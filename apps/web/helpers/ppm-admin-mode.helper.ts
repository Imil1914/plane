export function isPpmAdminMode(isGlobalAdmin: boolean, value: string | null): boolean {
  return isGlobalAdmin && value === "1";
}

export function getPpmAdminModeNavigationHref(href: string, isGlobalAdmin: boolean, value: string | null): string {
  if (!isPpmAdminMode(isGlobalAdmin, value)) return href;
  return `${href}${href.includes("?") ? "&" : "?"}ppm_admin_mode=1`;
}
