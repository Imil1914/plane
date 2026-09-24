import useSWR from "swr";
import { PpmAdminService } from "@/services/ppm-admin.service";

const adminService = new PpmAdminService();

export function usePpmAdminAccess() {
  const query = useSWR("ppm-admin-access", () => adminService.getAccess(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  return {
    ...query,
    isGlobalAdmin: query.data?.is_global_admin === true,
  };
}
