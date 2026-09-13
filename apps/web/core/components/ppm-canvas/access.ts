import { EUserPermissions } from "@plane/constants";

export type TPpmCanvasAccess = "deny" | "edit" | "read";

const CAN_READ = new Set([EUserPermissions.ADMIN, EUserPermissions.MEMBER, EUserPermissions.GUEST]);
const CAN_EDIT = new Set([EUserPermissions.ADMIN, EUserPermissions.MEMBER]);

export function resolvePpmCanvasAccess(role: EUserPermissions | undefined): TPpmCanvasAccess {
  if (role !== undefined && CAN_EDIT.has(role)) return "edit";
  if (role !== undefined && CAN_READ.has(role)) return "read";
  return "deny";
}
