import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { computePpmSprintScale } from "@/components/ppm-tasks/sprint";
import { PpmSprintScaleView } from "@/components/ppm-tasks/sprint-scale-view";

describe("PpmSprintScaleView", () => {
  it("renders name, range, day counter, ticks and today marker", () => {
    const scale = computePpmSprintScale("2026-09-16", "2026-09-29", new Date(2026, 8, 23, 12));
    if (!scale) throw new Error("scale expected");
    const html = renderToStaticMarkup(
      <PpmSprintScaleView
        name="Спринт 3"
        href="/ws/projects/p1/cycles/c1"
        rangeLabel="16–29 сент."
        openLabel="Открыть спринт"
        scaleLabel="Шкала спринта: 16–29 сент., день 8 из 14"
        todayLabel="сегодня"
        dayOfLabel="День 8 из 14"
        daysLeftLabel="осталось 6 дней"
        scale={scale}
        onOpen={() => undefined}
      />
    );
    expect(html).toContain('aria-label="Спринт 3"');
    expect(html).toContain('aria-label="Спринт 3, 16–29 сент. Открыть спринт"');
    expect(html).toContain('role="img" aria-label="Шкала спринта: 16–29 сент., день 8 из 14"');
    expect(html).toContain("День 8 из 14");
    expect(html).toContain("осталось 6 дней");
    expect(html.match(/class="ppm-sprint__tick"/g)?.length).toBe(14);
    expect(html).toContain('data-today="true"');
    expect(html).toContain("сегодня");
  });
});
