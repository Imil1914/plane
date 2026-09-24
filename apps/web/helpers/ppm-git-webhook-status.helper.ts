import type { TPpmGitConnection } from "@/services/ppm-git.service";
import { formatPpmTimeAgo } from "@/helpers/ppm-time-ago.helper";

export type TPpmGitWebhookStatus = {
  tone: "confirmed" | "waiting" | "inactive";
  label: string;
  detail: string;
};

const INACTIVE_CONNECTION_STATUSES = new Set<TPpmGitConnection["status"]>([
  "permission_drift",
  "suspended",
  "disconnected",
  "revoked",
]);

export function getPpmGitWebhookStatus(
  connection: Pick<TPpmGitConnection, "status" | "last_event_at">,
  locale = "ru",
  now = Date.now()
): TPpmGitWebhookStatus {
  if (INACTIVE_CONNECTION_STATUSES.has(connection.status)) {
    return {
      tone: "inactive",
      label: "Webhook неактивен",
      detail: "автоматические события не принимаются",
    };
  }

  if (connection.last_event_at && Number.isFinite(new Date(connection.last_event_at).getTime())) {
    return {
      tone: "confirmed",
      label: "Webhook подтверждён",
      detail: `последнее событие ${formatPpmTimeAgo(connection.last_event_at, locale, now)}`,
    };
  }

  return {
    tone: "waiting",
    label: "Webhook ещё не подтверждён",
    detail: "резервная синхронизация каждые 15 минут",
  };
}
