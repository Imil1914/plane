import re

from django.db import transaction

from .models import (
    PpmProjectVault,
    PpmVaultEntryKind,
    PpmVaultEntryStatus,
    PpmVaultLink,
    PpmVaultLinkStatus,
)


WIKI_LINK_PATTERN = re.compile(r"(?<!!)\[\[([^\[\]\n]{1,512})\]\]")


def normalize_vault_path(value):
    parts = []
    for raw_part in str(value or "").replace("\\", "/").strip().strip("/").split("/"):
        part = " ".join(raw_part.strip().split())
        if not part or part == ".":
            continue
        if part == "..":
            return ""
        parts.append(part.casefold())
    return "/".join(parts)


def entry_path(entry):
    names = []
    current = entry
    visited = set()
    while current and current.parent_id:
        if current.id in visited:
            return ""
        visited.add(current.id)
        names.append(current.name)
        current = current.parent
    return "/".join(reversed(names))


def extract_wiki_targets(content):
    targets = {}
    for match in WIKI_LINK_PATTERN.finditer(str(content or "")):
        raw = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        normalized = normalize_vault_path(raw)
        if normalized:
            targets.setdefault(normalized, raw)
    return targets


def _entry_keys(entry):
    path = normalize_vault_path(entry_path(entry))
    name = normalize_vault_path(entry.name)
    keys = {key for key in (path, name) if key}
    if name.endswith(".md"):
        keys.add(name[:-3])
    if path.endswith(".md"):
        keys.add(path[:-3])
    return keys


def _source_parent_path(source_entry):
    source_path = normalize_vault_path(entry_path(source_entry))
    return source_path.rsplit("/", 1)[0] if "/" in source_path else ""


def _resolver_index(vault):
    entries = list(
        vault.entries.filter(status=PpmVaultEntryStatus.ACTIVE)
        .exclude(kind=PpmVaultEntryKind.FOLDER)
        .select_related("parent", "parent__parent", "parent__parent__parent")
    )
    index = {}
    for entry in entries:
        for key in _entry_keys(entry):
            index.setdefault(key, set()).add(entry)
    for alias in vault.entry_aliases.select_related("entry").filter(entry__status=PpmVaultEntryStatus.ACTIVE):
        key = normalize_vault_path(alias.normalized_path)
        if key:
            index.setdefault(key, set()).add(alias.entry)
            if key.endswith(".md"):
                index.setdefault(key[:-3], set()).add(alias.entry)
    return index


def resolve_wiki_target(*, source_entry, normalized_target, resolver_index):
    parent_path = _source_parent_path(source_entry)
    if parent_path:
        relative_candidates = set(resolver_index.get(f"{parent_path}/{normalized_target}", set()))
        if normalized_target.endswith(".md"):
            relative_candidates.update(
                resolver_index.get(f"{parent_path}/{normalized_target[:-3]}", set())
            )
        else:
            relative_candidates.update(
                resolver_index.get(f"{parent_path}/{normalized_target}.md", set())
            )
        relative_candidates = {
            entry for entry in relative_candidates if entry.vault_id == source_entry.vault_id
        }
        if len(relative_candidates) == 1:
            return PpmVaultLinkStatus.RESOLVED, next(iter(relative_candidates))
        if len(relative_candidates) > 1:
            return PpmVaultLinkStatus.AMBIGUOUS, None

    candidates = set(resolver_index.get(normalized_target, set()))
    if normalized_target.endswith(".md"):
        candidates.update(resolver_index.get(normalized_target[:-3], set()))
    else:
        candidates.update(resolver_index.get(f"{normalized_target}.md", set()))
    candidates = {entry for entry in candidates if entry.vault_id == source_entry.vault_id}
    if len(candidates) == 1:
        return PpmVaultLinkStatus.RESOLVED, next(iter(candidates))
    if len(candidates) > 1:
        return PpmVaultLinkStatus.AMBIGUOUS, None
    return PpmVaultLinkStatus.MISSING, None


def reindex_entry_links(entry, *, resolver_index=None):
    if entry.kind != PpmVaultEntryKind.MARKDOWN or entry.status != PpmVaultEntryStatus.ACTIVE:
        PpmVaultLink.objects.filter(source_entry=entry).delete()
        return []
    version = entry.current_version
    if version is None:
        return []
    resolver_index = resolver_index or _resolver_index(entry.vault)
    targets = extract_wiki_targets(version.content_text)
    links = []
    for normalized_target, raw_target in targets.items():
        link_status, target_entry = resolve_wiki_target(
            source_entry=entry,
            normalized_target=normalized_target,
            resolver_index=resolver_index,
        )
        links.append(
            PpmVaultLink(
                workspace_id=entry.workspace_id,
                project_id=entry.project_id,
                vault=entry.vault,
                source_entry=entry,
                source_version=entry.version,
                raw_target=raw_target,
                normalized_target=normalized_target,
                target_entry=target_entry,
                status=link_status,
            )
        )
    with transaction.atomic():
        PpmVaultLink.objects.filter(source_entry=entry).delete()
        PpmVaultLink.objects.bulk_create(links)
    return links


def reindex_vault_links(vault: PpmProjectVault):
    resolver_index = _resolver_index(vault)
    entries = vault.entries.filter(
        kind=PpmVaultEntryKind.MARKDOWN,
        status=PpmVaultEntryStatus.ACTIVE,
    ).select_related("current_version", "parent")
    for entry in entries:
        reindex_entry_links(entry, resolver_index=resolver_index)


def serialize_link(link):
    return {
        "id": str(link.id),
        "source_entry_id": str(link.source_entry_id),
        "source_version": link.source_version,
        "raw_target": link.raw_target,
        "normalized_target": link.normalized_target,
        "target_entry_id": str(link.target_entry_id) if link.target_entry_id else None,
        "status": link.status,
    }
