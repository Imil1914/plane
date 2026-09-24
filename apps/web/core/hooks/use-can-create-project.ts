import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { isPpmShellEnabled } from "@ppm/brand";
import { canAccessPpmWorkspaceAdministration } from "@/helpers/ppm-workspace-access.helper";
import { useUserPermissions } from "@/hooks/store/user";
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";

export function useCanCreateProject(): boolean {
  const { allowPermissions } = useUserPermissions();
  const { isGlobalAdmin } = usePpmAdminAccess();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

  const hasLegacyCreateProjectPermission = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE
  );

  return (
    hasLegacyCreateProjectPermission &&
    canAccessPpmWorkspaceAdministration({
      isGlobalAdmin,
      isPpmShell,
    })
  );
}
