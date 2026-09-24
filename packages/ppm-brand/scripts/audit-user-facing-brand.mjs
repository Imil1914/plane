import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const auditScope = [
  "apps/web/core/components/account/auth-forms/auth-header.tsx",
  "apps/web/core/components/account/auth-forms/auth-root.tsx",
  "apps/web/core/components/account/terms-and-conditions.tsx",
  "apps/web/app/(all)/workspace-invitations/page.tsx",
  "apps/web/core/components/auth-screens/header.tsx",
  "apps/web/core/components/home/widgets/empty-states/no-projects.tsx",
  "apps/web/core/components/issues/create-issue-toast-action-items.tsx",
  "apps/web/core/components/issues/header.tsx",
  "apps/web/core/components/issues/issue-detail/issue-activity/activity/actions/default.tsx",
  "apps/web/core/components/issues/issue-update-status.tsx",
  "apps/web/core/components/issues/peek-overview/properties.tsx",
  "apps/web/core/components/instance/maintenance-message.tsx",
  "apps/web/core/components/navigation/project-navigation-items.ts",
  "apps/web/core/components/navigation/top-nav-power-k.tsx",
  "apps/web/core/components/power-k/config/help-commands.ts",
  "apps/web/core/components/onboarding/steps/profile/root.tsx",
  "apps/web/core/components/onboarding/steps/role/root.tsx",
  "apps/web/core/components/onboarding/steps/team/root.tsx",
  "apps/web/core/components/onboarding/steps/usecase/root.tsx",
  "apps/web/core/components/ppm-shell/product-logo.tsx",
  "apps/web/core/components/ppm-shell/project-feature-page.tsx",
  "apps/web/core/components/workspace/edition-badge.tsx",
  "apps/web/core/components/workspace/sidebar/projects-list.tsx",
  "apps/web/core/components/workspace/sidebar/sidebar-menu-items.tsx",
];

const allowlist = {
  "apps/web/core/components/account/auth-forms/auth-header.tsx": ["Welcome back to Plane", "Create your Plane account"],
  "apps/web/core/components/account/terms-and-conditions.tsx": [
    "plane.so/legals/terms-and-conditions",
    "plane.so/legals/privacy-policy",
  ],
  "apps/web/app/(all)/workspace-invitations/page.tsx": ["Plane account", "github.com/makeplane", "forum.plane.so"],
  "apps/web/core/components/auth-screens/header.tsx": ['"Plane"'],
  "apps/web/core/components/issues/peek-overview/properties.tsx": [': "Plane"'],
  "apps/web/core/components/instance/maintenance-message.tsx": ["Looks like Plane", "support@plane.so"],
  "apps/web/core/components/navigation/project-navigation-items.ts": ["buildPlaneNavigationItems"],
  "apps/web/core/components/power-k/config/help-commands.ts": [
    "docs.plane.so",
    "forum.plane.so",
    "github.com/makeplane",
  ],
  "apps/web/core/components/onboarding/steps/profile/root.tsx": ["appear in Plane"],
  "apps/web/core/components/onboarding/steps/role/root.tsx": ["set up Plane"],
  "apps/web/core/components/onboarding/steps/team/root.tsx": ["Work in plane", "use Plane"],
  "apps/web/core/components/onboarding/steps/usecase/root.tsx": ["brings you to Plane"],
  "apps/web/core/components/ppm-shell/product-logo.tsx": ["PlaneLockup", "PlaneLogo"],
};

const violations = [];

for (const relativePath of auditScope) {
  const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  const allowedFragments = allowlist[relativePath] ?? [];

  source.split("\n").forEach((line, index) => {
    if (!/\bplane\b|plane\.so|makeplane/i.test(line)) return;
    if (/^\s*(?:\/\/|\*|import\b)/.test(line)) return;
    if (line.includes('from "@plane/')) return;
    if (allowedFragments.some((fragment) => line.includes(fragment))) return;
    violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error("PPM user-facing brand audit failed:\n" + violations.map((value) => `- ${value}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`PPM user-facing brand audit passed (${auditScope.length} surfaces, controlled allowlist).`);
}
