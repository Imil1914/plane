// G2.1 (R12): every repository in «Код» has a disclosure «Как скачать код» with ready `git clone` commands (HTTPS and,
// when the address exists, SSH) and «Копировать» buttons that confirm «Скопировано». Copying falls back to a hidden
// text field where the Clipboard API is missing or refused (plain http, older browsers).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "@/components/ppm-git/git-clipboard";
import { buildGitCloneCommands, GitCloneCommands } from "@/components/ppm-git/git-clone-commands";
import { buttonsNamed, press } from "./element-tree";

const forgejoRepository = {
  id: "r-1",
  provider: "forgejo" as const,
  clone_https: "https://git.ppm.example/lab/robot.git",
  clone_ssh: "ssh://git@git.ppm.example:2222/lab/robot.git",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clone commands", () => {
  it("builds the exact HTTPS and SSH commands", () => {
    expect(buildGitCloneCommands(forgejoRepository)).toEqual([
      {
        kind: "https",
        label: "HTTPS",
        address: "https://git.ppm.example/lab/robot.git",
        command: "git clone https://git.ppm.example/lab/robot.git",
      },
      {
        kind: "ssh",
        label: "SSH",
        address: "ssh://git@git.ppm.example:2222/lab/robot.git",
        command: "git clone ssh://git@git.ppm.example:2222/lab/robot.git",
      },
    ]);
    expect(buildGitCloneCommands({ clone_https: "", clone_ssh: "git@github.com:lab/site.git" })).toEqual([
      {
        kind: "ssh",
        label: "SSH",
        address: "git@github.com:lab/site.git",
        command: "git clone git@github.com:lab/site.git",
      },
    ]);
  });

  it("leaves SSH out when the Git server has no SSH address", () => {
    for (const clone_ssh of ["", "   ", null]) {
      expect(buildGitCloneCommands({ ...forgejoRepository, clone_ssh }).map((item) => item.kind)).toEqual(["https"]);
    }
  });

  it("offers no command for an address that is unsafe to paste into a terminal or carries credentials", () => {
    for (const clone_https of [
      "https://git.ppm.example/lab/robot.git; rm -rf ~",
      "https://git.ppm.example/lab/$(whoami).git",
      "https://user:token@git.ppm.example/lab/robot.git",
      "http://git.ppm.example/lab/robot.git",
      "-uhttps://git.ppm.example/lab/robot.git",
    ]) {
      expect(buildGitCloneCommands({ clone_https, clone_ssh: "" })[0]?.command, clone_https).toBeNull();
    }
    expect(
      buildGitCloneCommands({ clone_https: "", clone_ssh: "ssh://root@git.ppm.example/lab/robot.git" })[0]
    ).toMatchObject({ command: null });
  });
});

describe("copying with a fallback", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyTextToClipboard("git clone https://git.ppm.example/lab/robot.git")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("git clone https://git.ppm.example/lab/robot.git");
  });

  it("falls back to a hidden text field when the Clipboard API refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) } });
    const field = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const button = { focus: vi.fn(), closest: vi.fn(() => null) };
    const body = { append: vi.fn() };
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("document", { activeElement: button, body, createElement: vi.fn(() => field), execCommand });

    await expect(copyTextToClipboard("git clone ssh://git@git.ppm.example:2222/lab/robot.git")).resolves.toBe(true);
    expect(field.value).toBe("git clone ssh://git@git.ppm.example:2222/lab/robot.git");
    expect(body.append).toHaveBeenCalledWith(field);
    expect(field.select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(field.remove).toHaveBeenCalled();
    expect(button.focus).toHaveBeenCalled();
  });

  it("keeps the fallback field inside an open dialog so its focus trap does not steal the selection", async () => {
    vi.stubGlobal("navigator", {});
    const field = { value: "", style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
    const dialog = { append: vi.fn() };
    const button = { focus: vi.fn(), closest: vi.fn(() => dialog) };
    vi.stubGlobal("document", {
      activeElement: button,
      body: { append: vi.fn() },
      createElement: () => field,
      execCommand: () => true,
    });

    await expect(copyTextToClipboard("git switch -c robot-7/gripper")).resolves.toBe(true);
    expect(button.closest).toHaveBeenCalledWith('[role="dialog"]');
    expect(dialog.append).toHaveBeenCalledWith(field);
  });

  it("reports a failure when neither way works", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);
    await expect(copyTextToClipboard("git clone x")).resolves.toBe(false);
  });
});

describe("«Как скачать код»", () => {
  const render = (repository: Parameters<typeof GitCloneCommands>[0]["repository"], copied?: string) =>
    renderToStaticMarkup(<GitCloneCommands copied={copied} onCopy={() => undefined} repository={repository} />);

  it("is a disclosure with both commands and «Копировать» buttons", () => {
    const html = render(forgejoRepository);
    expect(html).toContain("<details");
    expect(html).toMatch(/<summary[^>]*>.*Как скачать код.*<\/summary>/s);
    expect(html).toContain("git clone https://git.ppm.example/lab/robot.git");
    expect(html).toContain("git clone ssh://git@git.ppm.example:2222/lab/robot.git");
    expect(html.match(/>Копировать</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Копировать команду HTTPS"');
    expect(html).toContain('aria-label="Копировать команду SSH"');
    expect(html).not.toContain("GitHub");
  });

  it("copies the exact command of the pressed button", () => {
    const onCopy = vi.fn();
    const tree = GitCloneCommands({ onCopy, repository: forgejoRepository });

    press(buttonsNamed(tree, "Копировать команду SSH")[0]);
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(
      "git clone ssh://git@git.ppm.example:2222/lab/robot.git",
      "r-1:clone:ssh"
    );
    press(buttonsNamed(tree, "Копировать команду HTTPS")[0]);
    expect(onCopy).toHaveBeenLastCalledWith("git clone https://git.ppm.example/lab/robot.git", "r-1:clone:https");
  });

  it("hides SSH without an address", () => {
    const html = render({ ...forgejoRepository, clone_ssh: "" });
    expect(html).toContain("git clone https://git.ppm.example/lab/robot.git");
    expect(html).not.toContain("SSH");
  });

  it("confirms «Скопировано» on the copied command only", () => {
    const html = render(forgejoRepository, "r-1:clone:ssh");
    expect(html).toContain('aria-label="Скопировано: команда SSH"');
    expect(html.match(/>Скопировано</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Копировать команду HTTPS"');
    expect(html).toMatch(/role="status"[^>]*>Команда скопирована</);
  });

  it("shows the address without a command when it cannot be pasted safely", () => {
    const html = render({ id: "r-2", clone_https: "https://git.ppm.example/lab/$(x).git", clone_ssh: "" });
    expect(html).not.toContain("git clone");
    expect(html).not.toContain(">Копировать<");
    expect(html).toContain("нельзя безопасно вставить в терминал");
  });

  // G2.2 (R21): the viewer's identity on our Git server — an optional, pre-resolved prop (RepositoryCard forwards it
  // unchanged from route.tsx). Every test above passes none, so they also prove the block is absent by default.
  describe("forgejoIdentity (G2.2)", () => {
    const hint = {
      username: "robot" as string | null,
      usernameTemplate: "Ваше имя на Git-сервере: {username}",
      tokenHint: "Для HTTPS нужен токен: Git-сервер → Настройки → Приложения.",
      signInHint: "Войдите на Git-сервер кнопкой «Войти через PPM».",
      ssoLoginUrl: "https://git.ppm.example/user/oauth2/PPM" as string | null,
    };

    it("substitutes {username} into the pre-resolved template and shows the token hint", () => {
      const html = renderToStaticMarkup(
        <GitCloneCommands forgejoIdentity={hint} onCopy={() => undefined} repository={forgejoRepository} />
      );
      expect(html).toContain("Ваше имя на Git-сервере: robot");
      expect(html).toContain("Для HTTPS нужен токен: Git-сервер → Настройки → Приложения.");
    });

    it("links the sign-in hint when there is no account yet, and a link to offer", () => {
      const html = renderToStaticMarkup(
        <GitCloneCommands
          forgejoIdentity={{ ...hint, username: null }}
          onCopy={() => undefined}
          repository={forgejoRepository}
        />
      );
      expect(html).toMatch(
        /<a[^>]*href="https:\/\/git\.ppm\.example\/user\/oauth2\/PPM"[^>]*>Войдите на Git-сервер кнопкой «Войти через PPM»\.<\/a>/
      );
      expect(html).not.toContain("Ваше имя на Git-сервере");
    });

    it("is absent without forgejoIdentity at all — the exact baseline every test above already renders", () => {
      const html = render(forgejoRepository);
      expect(html).not.toContain("Ваше имя на Git-сервере");
      expect(html).not.toContain("Войдите на Git-сервер");
    });
  });

  // D-1: the block must not overflow the repository card, or the neighbouring card can cover «Копировать» (a real
  // layout/overflow bug that a node-environment render cannot reproduce — this locks in the two classes the fix
  // relies on, so the grid track stays capped at the card's width instead of the `<code>` element's full,
  // unwrapped/truncated command width).
  it("caps the command grid at the card's own width instead of an implicit content-sized column (D-1)", () => {
    const html = render(forgejoRepository);
    expect(html).toContain('class="grid grid-cols-[minmax(0,1fr)] gap-3 border-t border-subtle p-3"');
  });

  it("keeps each command row shrinkable so the row (and its «Копировать» button) never overflow the grid track (D-1)", () => {
    const html = render(forgejoRepository);
    // One per command (HTTPS + SSH here); an exact match so it can't accidentally hit the <code> element's own
    // longer `min-w-0 flex-1 truncate …` class list.
    expect(html.match(/<div class="min-w-0">/g)).toHaveLength(2);
  });
});
