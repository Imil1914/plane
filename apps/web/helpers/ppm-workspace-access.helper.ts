type TPpmWorkspaceAdministrationAccess = {
  isGlobalAdmin: boolean;
  isPpmShell: boolean;
};

/**
 * PPM has a protected, non-delegable global administrator role.
 * Project leads and participants stay scoped to the projects they were added to.
 */
export function canAccessPpmWorkspaceAdministration({
  isGlobalAdmin,
  isPpmShell,
}: TPpmWorkspaceAdministrationAccess): boolean {
  if (!isPpmShell) return true;
  return isGlobalAdmin;
}
