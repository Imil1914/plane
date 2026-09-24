import { describe, expect, it } from "vitest";
import { getPpmGitWebhookStatus } from "@/helpers/ppm-git-webhook-status.helper";

describe("PPM Git webhook status", () => {
  const now = new Date("2026-09-21T12:00:00.000Z").getTime();

  it("explains that reconciliation keeps an active connection current before the first webhook", () => {
    expect(getPpmGitWebhookStatus({ status: "active", last_event_at: null }, "ru", now)).toEqual({
      tone: "waiting",
      label: "Webhook ещё не подтверждён",
      detail: "резервная синхронизация каждые 15 минут",
    });
  });

  it("shows when a real signed event has reached PPM", () => {
    expect(getPpmGitWebhookStatus({ status: "active", last_event_at: "2026-09-21T11:18:00.000Z" }, "ru", now)).toEqual({
      tone: "confirmed",
      label: "Webhook подтверждён",
      detail: "последнее событие 42 минуты назад",
    });
  });

  it("does not promise synchronization after access has been revoked", () => {
    expect(getPpmGitWebhookStatus({ status: "revoked", last_event_at: "2026-09-21T11:18:00.000Z" }, "ru", now)).toEqual(
      {
        tone: "inactive",
        label: "Webhook неактивен",
        detail: "автоматические события не принимаются",
      }
    );
  });
});
