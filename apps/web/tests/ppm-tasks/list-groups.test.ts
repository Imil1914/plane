import { describe, expect, it } from "vitest";
import {
  getPpmCancelledStorageKey,
  isPpmCancelledGroup,
  localizePpmGroupColumns,
  parsePpmExpandedGroups,
  togglePpmExpandedGroup,
} from "@/components/ppm-tasks/list-groups";

const translate = (key: string) => `t:${key}`;
const column = (id: string, name: string) => ({ id, name, payload: {}, icon: undefined });
const noState = () => undefined;

describe("PPM task list groups", () => {
  it("renames the flat list group", () => {
    const [group] = localizePpmGroupColumns([column("All Issues", "All work items")], {
      groupBy: null,
      translate,
      getStateName: noState,
    });
    expect(group.name).toBe("t:tasks.group.all");
    expect(
      localizePpmGroupColumns([column("All Issues", "All Epics")], {
        groupBy: null,
        isEpic: true,
        translate,
        getStateName: noState,
      })[0].name
    ).toBe("t:tasks.group.all_epics");
  });

  it("renames None groups by grouping and keeps real names", () => {
    const run = (groupBy: "cycle" | "module" | "labels" | "assignees") =>
      localizePpmGroupColumns([column("c1", "Спринт 3"), column("None", "None")], {
        groupBy,
        translate,
        getStateName: noState,
      }).map((g) => g.name);
    expect(run("cycle")).toEqual(["Спринт 3", "t:tasks.group.no_cycle"]);
    expect(run("module")).toEqual(["Спринт 3", "t:tasks.group.no_module"]);
    expect(run("labels")).toEqual(["Спринт 3", "t:tasks.group.no_label"]);
    expect(run("assignees")).toEqual(["Спринт 3", "t:tasks.group.no_assignee"]);
  });

  it("uses the state display name for state grouping and keeps custom states", () => {
    const names: Record<string, string> = { s1: "Бэклог" };
    const groups = localizePpmGroupColumns([column("s1", "Backlog"), column("s2", "Ревью кода")], {
      groupBy: "state",
      translate,
      getStateName: (id) => names[id],
    });
    expect(groups.map((g) => g.name)).toEqual(["Бэклог", "Ревью кода"]);
  });

  it("translates state-group and priority groups", () => {
    expect(
      localizePpmGroupColumns([column("cancelled", "Canceled")], {
        groupBy: "state_detail.group",
        translate,
        getStateName: noState,
      })[0].name
    ).toBe("t:tasks.group.state_cancelled");
    expect(
      localizePpmGroupColumns([column("none", "None")], { groupBy: "priority", translate, getStateName: noState })[0]
        .name
    ).toBe("t:tasks.group.priority_none");
  });

  it("keeps the same object when nothing changes", () => {
    const original = column("l1", "Софт");
    expect(localizePpmGroupColumns([original], { groupBy: "labels", translate, getStateName: noState })[0]).toBe(
      original
    );
  });

  it("detects cancelled groups only for state groupings", () => {
    const GROUPS: Record<string, string> = { s9: "cancelled", s1: "backlog" };
    const groupOf = (id: string) => GROUPS[id];
    expect(isPpmCancelledGroup("state", "s9", groupOf)).toBe(true);
    expect(isPpmCancelledGroup("state", "s1", groupOf)).toBe(false);
    expect(isPpmCancelledGroup("state_detail.group", "cancelled", groupOf)).toBe(true);
    expect(isPpmCancelledGroup("priority", "cancelled", groupOf)).toBe(false);
    expect(isPpmCancelledGroup(null, "cancelled", groupOf)).toBe(false);
  });

  it("stores expanded cancelled groups per project, collapsed by default", () => {
    expect(getPpmCancelledStorageKey("p1")).toBe("ppm_tasks_cancelled_expanded:p1");
    expect(parsePpmExpandedGroups(null)).toEqual([]);
    expect(parsePpmExpandedGroups("not json")).toEqual([]);
    expect(parsePpmExpandedGroups('["s9", 3]')).toEqual(["s9"]);
    expect(togglePpmExpandedGroup([], "s9")).toEqual(["s9"]);
    expect(togglePpmExpandedGroup(["s9"], "s9")).toEqual([]);
  });
});
