import { describe, expect, it } from "vitest";
import {
  ppmAdminAccessSchema,
  ppmAdminAuditResponseSchema,
  ppmAdminProjectsResponseSchema,
  ppmAdminUsersResponseSchema,
} from "@/services/ppm-admin.service";

const pagination = { page: 1, page_size: 25, total: 1, has_next: false };

describe("PPM administrator API contracts", () => {
  it("accepts the protected role access response", () => {
    expect(
      ppmAdminAccessSchema.parse({
        is_global_admin: true,
        role: "ppm_global_admin",
        granted_at: "2026-09-19T10:00:00+03:00",
        reauthenticated_until: null,
      }).is_global_admin
    ).toBe(true);
  });

  it("accepts project integration health without pretending future integrations are ready", () => {
    const result = ppmAdminProjectsResponseSchema.parse({
      results: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          name: "PPM",
          identifier: "PPM",
          workspace: {
            workspace_id: "22222222-2222-4222-8222-222222222222",
            name: "Project School",
            slug: "project-school",
          },
          lead: null,
          member_count: 4,
          status: "active",
          updated_at: "2026-09-19T10:00:00+03:00",
          integrations: {
            canvas: { status: "ready", active_boards: 2, archived_boards: 0, current_version: 3 },
            vault: { status: "not_configured", available: false },
            brain: { status: "not_configured", available: false },
            git: { status: "not_configured", available: false },
          },
        },
      ],
      pagination,
    });

    expect(result.results[0]?.integrations.canvas.active_boards).toBe(2);
    expect(result.results[0]?.integrations.git.available).toBe(false);
  });

  it("accepts users and audit events", () => {
    expect(
      ppmAdminUsersResponseSchema.parse({
        results: [
          {
            user_id: "33333333-3333-4333-8333-333333333333",
            display_name: "Administrator",
            email: "admin@ppm.local",
            avatar_url: null,
            is_active: true,
            is_bot: false,
            is_global_admin: true,
            workspace_count: 2,
            project_count: 5,
            last_active: null,
          },
        ],
        pagination,
      }).results
    ).toHaveLength(1);

    expect(
      ppmAdminAuditResponseSchema.parse({
        results: [
          {
            audit_id: "44444444-4444-4444-8444-444444444444",
            action: "project_admin_mode_enter",
            actor: {
              user_id: "33333333-3333-4333-8333-333333333333",
              display_name: "Administrator",
              email: "admin@ppm.local",
            },
            workspace_id: "22222222-2222-4222-8222-222222222222",
            project_id: "11111111-1111-4111-8111-111111111111",
            method: "POST",
            path: "/api/ppm/v1/admin/projects/11111111-1111-4111-8111-111111111111/enter/",
            request_id: "55555555-5555-4555-8555-555555555555",
            metadata: {},
            created_at: "2026-09-19T10:00:00+03:00",
          },
        ],
        pagination,
      }).results[0]?.action
    ).toBe("project_admin_mode_enter");
  });

  it("rejects an invalid protected role", () => {
    expect(() =>
      ppmAdminAccessSchema.parse({
        is_global_admin: true,
        role: "workspace_admin",
        granted_at: null,
        reauthenticated_until: null,
      })
    ).toThrow();
  });
});
