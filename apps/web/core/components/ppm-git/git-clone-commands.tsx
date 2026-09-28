// G2.1 (R12): «Как скачать код» — ready `git clone` commands of a repository for both providers, each with its own
// «Копировать» button. The page (route.tsx) copies with a fallback and marks the copied command for a moment.
// D-1 fix: the command row's grid used an implicit `auto` column, sized to the `<code>` element's unwrapped
// (nowrap/truncate) content width instead of the card's available width — the block then overflowed the repository
// card and the neighbouring card covered «Копировать». `grid-cols-[minmax(0,1fr)]` below caps the column at the
// container's width (its max is a flexible `1fr`, not open-ended `auto`); `min-w-0` on the per-command wrapper is
// belt-and-braces so the row (and the button inside it) never depends on a sibling column to be visible.
import { Check, ChevronDown, Clipboard, Download } from "lucide-react";

export type TPpmGitCloneCommand = {
  kind: "https" | "ssh";
  label: "HTTPS" | "SSH";
  address: string;
  /** Null when the address is unsafe to paste into a terminal or carries credentials: no ready command then. */
  command: string | null;
};

type TPpmGitCloneSource = { clone_https?: string | null; clone_ssh?: string | null };

// A plain Git address only: spaces, quotes, `;`, `$`, backticks, `|`, `&`, `!`, globs and parentheses could turn a
// pasted command into something else, so such an address gets no ready command.
const SHELL_NEUTRAL = /^[A-Za-z0-9._~:/@%+=-]+$/;
const HTTPS_ADDRESS = /^https:\/\/[^/@]+\/./i; // no user:password@ before the host
const SSH_ADDRESS = /^(?:ssh:\/\/git@[^/@]+\/|git@[^/:@]+:)[^/]/i;

function isSafeCloneAddress(kind: TPpmGitCloneCommand["kind"], address: string) {
  if (!SHELL_NEUTRAL.test(address)) return false;
  return kind === "https" ? HTTPS_ADDRESS.test(address) : SSH_ADDRESS.test(address);
}

export function buildGitCloneCommands(repository: TPpmGitCloneSource): TPpmGitCloneCommand[] {
  const sources = [
    { kind: "https", label: "HTTPS", value: repository.clone_https },
    { kind: "ssh", label: "SSH", value: repository.clone_ssh },
  ] as const;
  return sources.flatMap(({ kind, label, value }) => {
    const address = value?.trim() ?? "";
    if (!address) return [];
    return [{ kind, label, address, command: isSafeCloneAddress(kind, address) ? `git clone ${address}` : null }];
  });
}

export function gitCloneCopyKey(repositoryId: string, kind: TPpmGitCloneCommand["kind"]) {
  return `${repositoryId}:clone:${kind}`;
}

export function GitCloneCommands({
  copied,
  onCopy,
  repository,
}: {
  copied?: string;
  onCopy: (value: string, key: string) => void;
  repository: { id: string } & TPpmGitCloneSource;
}) {
  const commands = buildGitCloneCommands(repository);
  if (commands.length === 0) return null;
  const copiedHere = commands.some((item) => copied === gitCloneCopyKey(repository.id, item.kind));
  const hasSsh = commands.some((item) => item.kind === "ssh" && item.command);
  return (
    <details className="group mt-3 rounded-lg border border-subtle bg-layer-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-2 [&::-webkit-details-marker]:hidden">
        <Download className="size-3.5 text-accent-primary" aria-hidden="true" />
        Как скачать код
        <ChevronDown
          className="ml-auto size-3.5 text-tertiary transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 border-t border-subtle p-3">
        {commands.map(({ address, command, kind, label }) => {
          const key = gitCloneCopyKey(repository.id, kind);
          const isCopied = copied === key;
          return (
            <div key={kind} className="min-w-0">
              <p className="text-11 font-semibold text-tertiary">{label}</p>
              {command ? (
                <div className="mt-1 flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 truncate rounded-md border border-subtle bg-surface-2 px-2 py-1.5 text-12 text-secondary"
                    title={command}
                  >
                    {command}
                  </code>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-2"
                    aria-label={isCopied ? `Скопировано: команда ${label}` : `Копировать команду ${label}`}
                    onClick={() => onCopy(command, key)}
                  >
                    {isCopied ? (
                      <Check className="size-3.5 text-icon-success-primary" aria-hidden="true" />
                    ) : (
                      <Clipboard className="size-3.5" aria-hidden="true" />
                    )}
                    {isCopied ? "Скопировано" : "Копировать"}
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-12 leading-5 break-all text-secondary">
                  Адрес <code>{address}</code> нельзя безопасно вставить в терминал, поэтому готовой команды нет.
                </p>
              )}
            </div>
          );
        })}
        <p className="text-11 leading-5 text-tertiary">
          {hasSsh
            ? "По HTTPS Git спросит логин и токен доступа, по SSH нужен ключ, добавленный в ваш профиль на Git-сервере."
            : "Git спросит логин и токен доступа к Git-серверу."}
        </p>
        <span className="sr-only" role="status">
          {copiedHere ? "Команда скопирована" : ""}
        </span>
      </div>
    </details>
  );
}
