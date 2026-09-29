// G2.3 (line G-Web): plain-Russian error text for the «Вставить коммит/PR» search and the «Что сделано за период»
// summary — same idea as `getPpmForgejoErrorMessage` in ppm-git.service.ts (code wins over HTTP status), kept next to
// the dialogs rather than in the service file since these two messages are specific to the G2.3 dialogs, not to the
// service's own contract errors.
import { PpmGitServiceError } from "@/services/ppm-git.service";

const GIT_OBJECT_SEARCH_FALLBACK = "Не удалось получить коммиты и PR проекта.";
const WORK_SUMMARY_FALLBACK = "Не удалось собрать сводку за период.";

/** The search dialog's error banner text; `GIT_PERMISSION_DENIED` (no «Код» access, or a project the viewer cannot
 * see) gets its own understandable sentence instead of the generic fallback — Review Focus / G6 requirement. */
export function getGitObjectSearchErrorMessage(reason: unknown): string {
  if (reason instanceof PpmGitServiceError) {
    if (reason.code === "GIT_PERMISSION_DENIED" || reason.status === 403) {
      return "Нет доступа к разделу «Код» этого проекта.";
    }
    if (reason.message) return reason.message;
  }
  return reason instanceof Error && reason.message ? reason.message : GIT_OBJECT_SEARCH_FALLBACK;
}

/** The work-summary dialog's error banner text. Review round 2 (#1): `WORK_SUMMARY_RANGE_INVALID` covers several
 * distinct reasons server-side (too long, malformed date, "from" after "to", …) with one shared code — the API's own
 * `message` already names the actual reason in Russian (`work_summary.py`), so it is shown as-is instead of a single
 * hardcoded "too long" sentence that would be wrong for the other reasons under the same code. `GIT_PERMISSION_DENIED`
 * keeps its own sentence (the API's generic permission text does not name "Код" the way the rest of this dialog does);
 * anything else falls through to the API's own message, then the generic fallback. */
export function getWorkSummaryErrorMessage(reason: unknown): string {
  if (reason instanceof PpmGitServiceError) {
    if (reason.code === "GIT_PERMISSION_DENIED" || reason.status === 403) {
      return "Нет доступа к этому проекту.";
    }
    if (reason.message) return reason.message;
  }
  return reason instanceof Error && reason.message ? reason.message : WORK_SUMMARY_FALLBACK;
}
