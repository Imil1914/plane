import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PpmTaskBlockedMarkerView, PpmTaskEvidenceView } from "@/components/ppm-tasks/task-evidence-view";

describe("evidence views", () => {
  it("renders PR and materials with screen-reader text", () => {
    const html = renderToStaticMarkup(
      <PpmTaskEvidenceView
        pullRequest={{ label: "#48", srLabel: "PR #48", more: 1, titles: "Калибровка\nКалибровка 2" }}
        materials={{ count: 2, srLabel: "Материалов: 2", title: "Вложений: 1 · ссылок: 1" }}
      />
    );
    expect(html).toContain('<span class="sr-only">PR #48</span>');
    expect(html).toContain("#48");
    expect(html).toContain("+1");
    expect(html).toContain('<span class="sr-only">Материалов: 2</span>');
  });

  it("renders nothing without evidence (no dash)", () => {
    expect(renderToStaticMarkup(<PpmTaskEvidenceView pullRequest={null} materials={null} />)).toBe("");
  });

  it("renders the blocked marker as ⊣ + task id with a spoken label", () => {
    const html = renderToStaticMarkup(
      <PpmTaskBlockedMarkerView
        srText="Заблокирована задачей ROBOT-12"
        identifier="ROBOT-12"
        more={0}
        title="ROBOT-12 · Датчик"
      />
    );
    expect(html).toContain('class="ppm-task-blocked"');
    expect(html).toContain('<span class="sr-only">Заблокирована задачей ROBOT-12</span>');
    expect(html).toContain("ROBOT-12");
    expect(html).toContain("<svg");
  });
});
