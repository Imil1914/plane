"""Server-built previews of Vault files for the Canvas and the Vault UI (AF2.1).

Security model: nothing in a document is executed. Office Open XML parts are read with
zipfile + lxml (entities not resolved, no network, no DTD) and openpyxl in read-only/data-only
mode (formulas are never evaluated, VBA is never loaded).

Archives. Limits are checked on the central directory before any part is decompressed: member
count, declared total size, compression ratio, encryption, and every member must be STORED or
DEFLATED — zipfile's incremental reader only bounds decompressed *output* to the requested read
size for those two methods; for BZIP2/LZMA it decompresses whatever compressed chunk it read in a
single call, so a small, highly compressible BZIP2/LZMA member could inflate far past any declared
size or per-read cap. Part names must be unique the way OPC compares them (case-insensitively,
with "\\" read as "/" and no leading "/"): zipfile resolves a name to the last of several
same-named entries, so duplicates would let one part be read many times while the declared total
counted each entry once. Parts are then always read through the ``ZipInfo`` of the single entry
that carries their name, each read is capped at ``XML_TREE_MAX_BYTES`` and at the member's own
declared size (+1, to detect a member that inflates past it), and every read — a repeated read of
the same part included — is charged to one running total bounded by ``zip_max_uncompressed_bytes``.

Spreadsheets. openpyxl never opens the uploaded archive. ``load_workbook()`` cannot be interrupted
by the time budget, and on the original parts its work is not bounded by their size: it re-parses
a chartsheet with every chart of its drawing once per ``<sheet>`` that references it, scans a
whole worksheet once per such reference, runs a quadratic regex over print-title/print-area
defined names, expands every named style against the whole custom number-format list and re-scans
a number-format code once per cell format. It therefore gets a minimal package rebuilt here from
the workbook's relationships (never from member names): the worksheet parts of the first
``XLSX_MAX_WORKBOOK_SHEETS`` distinct worksheets (each part once, however many ``<sheet>`` entries
point to it), the shared strings and the theme as stored, plus generated parts — content types and
relationships, a workbook part that keeps only the date system and those sheets, and a styles part
that only says which cell formats are dates. Chartsheets, drawings, charts, media, pivot tables,
external links, defined names, named styles and everything else are never read, and what openpyxl
still does is linear in what we read: at most ``zip_max_uncompressed_bytes`` of XML.

Every parsing loop of ours runs under an output and time budget, and at most two previews are
parsed concurrently per process (the compute-slot gate covers only that parsing, not the cheap
format checks before it or the storage download that precedes it). docx HTML is assembled from
escaped text and passed through nh3 with a tag allowlist and no attributes.
"""

import codecs
import collections
import datetime
import hashlib
import html
import io
import logging
import posixpath
import threading
import time
import warnings
import zipfile

import nh3
from django.conf import settings
from django.core.cache import cache
from lxml import etree

from .formats import OFFICE_PREVIEW_EXTENSIONS, TEXT_PREVIEW_EXTENSIONS
from .models import PpmVaultEntryKind
from .storage import open_private_object


logger = logging.getLogger("plane.api")

# openpyxl emits advisory warnings (missing default style, unsupported extensions, …) that are
# irrelevant to a read-only, values-only preview. Filtered once here, at import time, because
# `warnings.catch_warnings()` mutates process-global state and is documented as not thread-safe;
# previews now run with real concurrency (see PREVIEW_COMPUTE_SLOTS below), so a per-call
# catch_warnings() context would race across threads.
warnings.filterwarnings("ignore", module="openpyxl")

PREVIEW_SCHEMA_VERSION = 3  # bumped in fix rounds 3 and 4: drops previews cached under the pre-fix logic
CACHE_PREFIX = "ppm:vault-preview:"

# Every part we read is about to be parsed (into an lxml tree here, or by openpyxl), so each read
# is capped well below the overall archive budget: tree construction can amplify raw bytes several
# times over (many small elements each become an object), so this bounds worst-case memory for
# that step independent of the (larger) total-archive-size limit.
XML_TREE_MAX_BYTES = 5 * 1024 * 1024

# Caps how many previews are actually being computed at once, process-wide. A cache hit never
# reaches this gate (build_entry_preview returns the cached payload first), so this only throttles
# genuine cache-miss parsing: rather than let requests queue unboundedly behind CPU/memory-heavy
# document parsing, a request that cannot get a slot within a short timeout fails fast.
PREVIEW_COMPUTE_SLOTS = threading.BoundedSemaphore(2)
PREVIEW_COMPUTE_TIMEOUT_SECONDS = 1.0

# Non-deterministic outcomes (depend on server load at compute time, or on an unanticipated
# exception rather than the file's content) get a short cache TTL instead of the full one.
UNSTABLE_CACHE_TTL_SECONDS = 60

XLSX_MAX_SHEETS = 5
# Distinct worksheets handed to openpyxl (it scans each one once while loading); of these, up to
# XLSX_MAX_SHEETS visible ones are rendered.
XLSX_MAX_WORKBOOK_SHEETS = 20
XLSX_MAX_CELL_FORMATS = 65_536  # cellXfs entries; Excel itself allows 64 000
XLSX_NUMBER_FORMAT_MAX_CHARS = 255  # Excel's own limit for one number-format code
XLSX_MAX_ROWS = 200
XLSX_MAX_COLS = 50
# Excel's own UI caps a sheet name at 31 characters, but a forged/foreign workbook is not bound by
# that (worksheet.title has no size limit of its own) — truncated before it is charged to the
# output budget like every other piece of text in the payload.
XLSX_SHEET_NAME_MAX_CHARS = 100
CELL_MAX_CHARS = 300
PPTX_MAX_SLIDES = 200
SLIDE_TITLE_MAX_CHARS = 300
SLIDE_TEXT_MAX_CHARS = 4000
DOCX_MAX_BLOCKS = 3000
DOCX_TABLE_MAX_ROWS = 200
DOCX_TABLE_MAX_COLS = 50
OLE_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ALLOWED_HTML_TAGS = {"p", "h1", "h2", "h3", "h4", "ul", "li", "br", "table", "tbody", "tr", "td"}

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
XLSX_TYPES = {
    "workbook": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    "worksheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
    "sharedStrings": "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
    "styles": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    "theme": "application/vnd.openxmlformats-officedocument.theme+xml",
}


def _q(namespace, tag):
    return f"{{{namespace}}}{tag}"


W_BODY, W_P, W_PPR, W_PSTYLE, W_NUMPR, W_VAL = (
    _q(W, "body"),
    _q(W, "p"),
    _q(W, "pPr"),
    _q(W, "pStyle"),
    _q(W, "numPr"),
    _q(W, "val"),
)
W_T, W_TAB, W_BR, W_CR, W_NBH = _q(W, "t"), _q(W, "tab"), _q(W, "br"), _q(W, "cr"), _q(W, "noBreakHyphen")
W_TBL, W_TR, W_TC = _q(W, "tbl"), _q(W, "tr"), _q(W, "tc")
W_CONTAINERS = {_q(W, "sdt"), _q(W, "sdtContent"), _q(W, "customXml")}
W_SKIPPED = {_q(W, "del"), _q(W, "moveFrom"), _q(W, "delText"), _q(W, "instrText"), _q(MC, "Fallback")}
A_P, A_T, A_BR, A_TC = _q(A, "p"), _q(A, "t"), _q(A, "br"), _q(A, "tc")


class PreviewRejected(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class PreviewTimeBudgetExhausted(PreviewRejected):
    """The time budget ran out before there was anything to show.

    Answered like any other ``limits`` rejection, but it depends on server load at that moment
    rather than on the file, so ``build_entry_preview`` caches it only briefly.
    """

    def __init__(self):
        super().__init__("limits")


class PreviewStorageUnavailable(Exception):
    pass


def _limit(name, default):
    return int(getattr(settings, name, default))


def preview_limits():
    return {
        "source_max_bytes": _limit("PPM_VAULT_PREVIEW_SOURCE_MAX_BYTES", 16 * 1024 * 1024),
        "zip_max_members": _limit("PPM_VAULT_PREVIEW_ZIP_MAX_MEMBERS", 2000),
        "zip_max_uncompressed_bytes": _limit("PPM_VAULT_PREVIEW_ZIP_MAX_UNCOMPRESSED_BYTES", 20 * 1024 * 1024),
        "zip_max_ratio": _limit("PPM_VAULT_PREVIEW_ZIP_MAX_RATIO", 200),
        "text_max_bytes": _limit("PPM_VAULT_PREVIEW_TEXT_MAX_BYTES", 256 * 1024),
        "output_max_chars": _limit("PPM_VAULT_PREVIEW_MAX_OUTPUT_CHARS", 400_000),
        "time_budget_ms": _limit("PPM_VAULT_PREVIEW_TIME_BUDGET_MS", 5000),
        "cache_seconds": _limit("PPM_VAULT_PREVIEW_CACHE_SECONDS", 86_400),
    }


class _Budget:
    """Caps total output characters and wall time; hitting a cap marks the preview truncated."""

    def __init__(self, limits):
        self.deadline = time.monotonic() + limits["time_budget_ms"] / 1000
        self.chars_left = limits["output_max_chars"]
        self.truncated = False

    def expired(self):
        if time.monotonic() > self.deadline:
            self.truncated = True
            return True
        return False

    def check(self):
        """For steps before any output exists: running out of time there leaves nothing to show."""
        if self.expired():
            raise PreviewTimeBudgetExhausted()

    def take(self, text, max_chars=None):
        if max_chars is not None and len(text) > max_chars:
            text = text[:max_chars]
            self.truncated = True
        if self.chars_left <= 0:
            self.truncated = True
            return None
        if len(text) > self.chars_left:
            text = text[: self.chars_left]
            self.truncated = True
        self.chars_left -= len(text)
        return text


def _unsupported(reason):
    return {"kind": "unsupported", "reason": reason, "truncated": False}


def build_entry_preview(entry):
    """Return the preview payload of the entry's current version (cached by content hash)."""
    version = entry.current_version
    if version is None:
        return {"entry_id": str(entry.id), "version": 0, "content_hash": "", "extension": "", **_unsupported("type")}
    limits = preview_limits()
    key = _cache_key(entry=entry, version=version, limits=limits)
    payload = _cache_get(key)
    if payload is None:
        load_dependent = False
        try:
            payload = _compute_preview(entry=entry, version=version, limits=limits)
        except PreviewTimeBudgetExhausted as exhausted:
            payload, load_dependent = _unsupported(exhausted.reason), True
        _cache_set(key, payload, _cache_ttl(payload, limits, load_dependent=load_dependent))
    return {
        "entry_id": str(entry.id),
        "version": version.version,
        "content_hash": version.content_hash or "",
        "extension": entry.extension or "",
        **payload,
    }


def _cache_key(*, entry, version, limits):
    fingerprint = "|".join(
        [
            str(PREVIEW_SCHEMA_VERSION),
            entry.kind,
            (entry.extension or "").casefold(),
            version.content_hash or f"version:{version.id}",
            ",".join(f"{name}={limits[name]}" for name in sorted(limits) if name != "cache_seconds"),
        ]
    )
    return CACHE_PREFIX + hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()


def _cache_get(key):
    try:
        return cache.get(key)
    except Exception:  # noqa: BLE001 - a cache outage must degrade to recomputation, not a 500
        logger.warning("PPM vault preview cache read failed")
        return None


def _cache_set(key, payload, timeout):
    try:
        cache.set(key, payload, timeout)
    except Exception:  # noqa: BLE001
        logger.warning("PPM vault preview cache write failed")


def _cache_ttl(payload, limits, *, load_dependent=False):
    """Shorten the TTL for outcomes that are not purely a function of the file's content.

    A truncated result can depend on server load at compute time (the time budget), not only on
    the file itself; so does a ``limits`` rejection caused by the time budget running out before
    anything could be shown (``load_dependent``); and the generic-exception ``invalid`` fallback
    can hide a transient or environmental failure rather than a genuinely malformed document. All
    of these get a short TTL so a bad moment does not stick in the cache for the full
    ``cache_seconds`` (default 24h); size/structure ``limits`` are deterministic and keep it.
    """
    if (
        load_dependent
        or payload.get("truncated")
        or (payload.get("kind") == "unsupported" and payload.get("reason") == "invalid")
    ):
        return min(UNSTABLE_CACHE_TTL_SECONDS, limits["cache_seconds"])
    return limits["cache_seconds"]


def _preview_format(entry):
    extension = (entry.extension or "").casefold()
    if entry.kind == PpmVaultEntryKind.MARKDOWN:
        return "markdown"
    if entry.kind != PpmVaultEntryKind.FILE:
        return None
    if extension in OFFICE_PREVIEW_EXTENSIONS:
        return extension
    if extension in TEXT_PREVIEW_EXTENSIONS:
        return "text"
    return None


def _compute_preview(*, entry, version, limits):
    """Compute a preview, holding the process-wide compute slot only around real parsing.

    A cache hit never reaches this function (``build_entry_preview`` returns the cached payload
    first), so everything here only runs on a genuine cache miss. Format detection, the markdown
    short-circuit (its text is already in the database — no storage read at all) and the
    declared-size check are cheap and run unguarded; the storage download is I/O, not CPU/memory
    work, so it also runs unguarded (a slow download should not hold a parsing slot another
    request needs). Only docx/xlsx/pptx parsing — the CPU/memory-heavy step — is gated: at most
    ``PREVIEW_COMPUTE_SLOTS`` run concurrently per process, and a request that cannot get a slot
    within a short timeout fails the same way storage failures do (503) rather than queueing
    unboundedly.
    """
    preview_format = _preview_format(entry)
    if preview_format is None:
        return _unsupported("type")
    if preview_format == "markdown":
        return _text_payload((version.content_text or "").encode("utf-8"), limits)
    if int(version.size_bytes or 0) > limits["source_max_bytes"]:
        return _unsupported("too_large")
    raw = _read_object(version.object_key, limits["source_max_bytes"])
    if raw is None:
        return _unsupported("too_large")
    if preview_format == "text":
        return _text_payload(raw, limits)
    if not PREVIEW_COMPUTE_SLOTS.acquire(timeout=PREVIEW_COMPUTE_TIMEOUT_SECONDS):
        logger.warning("PPM vault preview: compute slots exhausted", extra={"entry_id": str(entry.id)})
        raise PreviewStorageUnavailable()
    try:
        return _parse_office_payload(entry=entry, preview_format=preview_format, raw=raw, limits=limits)
    finally:
        PREVIEW_COMPUTE_SLOTS.release()


def _parse_office_payload(*, entry, preview_format, raw, limits):
    try:
        if raw.startswith(OLE_SIGNATURE):
            raise PreviewRejected("encrypted")
        if preview_format == "docx":
            return _docx_payload(raw, limits)
        if preview_format == "xlsx":
            return _xlsx_payload(raw, limits)
        return _pptx_payload(raw, limits)
    except PreviewTimeBudgetExhausted:
        raise  # build_entry_preview answers "limits" and caches it only briefly
    except PreviewRejected as rejected:
        return _unsupported(rejected.reason)
    except Exception as exc:  # noqa: BLE001 - malformed third-party documents must not become 500s
        logger.info(
            "PPM vault preview could not parse a document",
            extra={"entry_id": str(entry.id), "error": type(exc).__name__},
        )
        return _unsupported("invalid")


def _read_object(object_key, max_bytes):
    try:
        file_obj = open_private_object(object_key)
    except Exception as exc:  # noqa: BLE001 - any storage-open failure is a 503, not a 500
        raise PreviewStorageUnavailable() from exc
    if file_obj is None:
        raise PreviewStorageUnavailable()
    try:
        data = file_obj.read(max_bytes + 1)
    except Exception as exc:  # noqa: BLE001 - botocore/s3transfer errors surface lazily on read()
        raise PreviewStorageUnavailable() from exc
    finally:
        file_obj.close()
    return None if len(data) > max_bytes else data


def _text_payload(raw, limits):
    cap = limits["text_max_bytes"]
    truncated = len(raw) > cap
    chunk = raw[:cap]
    if b"\x00" in chunk:
        return _unsupported("binary")
    try:
        text = codecs.getincrementaldecoder("utf-8-sig")("strict").decode(chunk, final=not truncated)
        encoding = "utf-8"
    except UnicodeDecodeError:
        text = chunk.decode("cp1251", errors="replace")
        encoding = "windows-1251"
    return {"kind": "text", "text": text, "encoding": encoding, "truncated": truncated}


def _part_key(name):
    """How OPC compares part names: case-insensitively, with "\\" as "/" and no leading "/"."""
    return name.replace("\\", "/").lstrip("/").casefold()


class _Archive:
    """An Office archive that passed ``_open_archive``: unique part names and a read budget.

    Parts are looked up in our own index by ``_part_key`` and read through that entry's
    ``ZipInfo`` — never through ``ZipFile.getinfo(name)``/``read(name)``, which resolve a name to
    the last of several same-named entries. ``bytes_left`` is the running total-uncompressed
    budget every read is charged against, repeated reads of one part included.
    """

    def __init__(self, zip_file, parts, limits):
        self.zip_file = zip_file
        self.parts = parts
        self.bytes_left = limits["zip_max_uncompressed_bytes"]

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.zip_file.close()

    def find(self, name):
        return self.parts.get(_part_key(name)) if name else None


def _open_archive(raw, limits):
    try:
        zip_file = zipfile.ZipFile(io.BytesIO(raw))
    except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, OSError) as exc:
        raise PreviewRejected("invalid") from exc
    try:
        members = zip_file.infolist()
        if len(members) > limits["zip_max_members"]:
            raise PreviewRejected("limits")
        parts = {}
        total = 0
        for member in members:
            if member.flag_bits & 0x1:
                raise PreviewRejected("encrypted")
            if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                # zipfile only bounds decompressed *output* to the requested read size for
                # STORED/DEFLATED; BZIP2/LZMA decompress a whole chunk of input in one call
                # regardless of how much output was asked for (see module docstring).
                raise PreviewRejected("limits")
            key = _part_key(member.filename)
            if key in parts:
                # zipfile maps a name to the last entry carrying it, so N same-named entries
                # would be N reads of one (possibly large) part while the total below counts
                # each (possibly empty) entry once.
                raise PreviewRejected("limits")
            parts[key] = member
            total += member.file_size
            if total > limits["zip_max_uncompressed_bytes"]:
                raise PreviewRejected("limits")
            if member.file_size > 1024 * 1024 and member.file_size > member.compress_size * limits["zip_max_ratio"]:
                raise PreviewRejected("limits")
    except PreviewRejected:
        zip_file.close()
        raise
    return _Archive(zip_file, parts, limits)


def _read_member(archive, member):
    """Read one entry of ``archive`` (a ``ZipInfo`` from its own index), charged to its budget."""
    cap = min(XML_TREE_MAX_BYTES, archive.bytes_left)
    if member.file_size > cap:
        # Reject on the declared size alone before attempting any read: no decompression, no
        # matter how small the actual compressed data is.
        raise PreviewRejected("limits")
    # Never ask the decompressor for more output than the member's own declared size needs
    # (+1, to still detect a member that inflates past it): a forged member that declares a tiny
    # size while padding the compressed stream far past it must not be able to make us request a
    # large read just because our cap happens to be large.
    with archive.zip_file.open(member) as handle:
        data = handle.read(member.file_size + 1)
    if len(data) > cap:
        raise PreviewRejected("limits")
    archive.bytes_left -= len(data)
    return data


def _read_part(archive, name, *, required=True):
    member = archive.find(name)
    if member is None:
        if required:
            raise PreviewRejected("invalid")
        return None
    return _read_member(archive, member)


def _xml(data):
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        dtd_validation=False,
        huge_tree=False,
        remove_comments=True,
        remove_pis=True,
    )
    try:
        return etree.fromstring(data, parser)
    except etree.XMLSyntaxError as exc:
        raise PreviewRejected("invalid") from exc


def _sanitize(markup):
    return nh3.clean(markup, tags=ALLOWED_HTML_TAGS, attributes={"*": set()}, url_schemes=set())


def _escape(text):
    return html.escape(text).replace("\n", "<br>")


# --- OPC relationships ------------------------------------------------------------------------


def _localname(element):
    return element.tag.rsplit("}", 1)[-1] if isinstance(element.tag, str) else ""


def _part_name(base, target):
    """Resolve a relationship target against its source part's folder; None if it leaves the package."""
    target = (target or "").strip().replace("\\", "/")
    if not target:
        return None
    name = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(base, target))
    return None if name in (".", "..") or name.startswith("../") else name


def _rels_part_name(part):
    folder, name = posixpath.split(part)
    return posixpath.join(folder, "_rels", f"{name}.rels")


_Relationship = collections.namedtuple("_Relationship", "id type name member")


def _relationships(archive, part, budget):
    """Internal relationships of ``part`` ("" = the package) whose targets exist in the archive."""
    budget.check()
    data = _read_part(archive, _rels_part_name(part), required=False)
    if data is None:
        return []
    base = posixpath.dirname(part)
    found = []
    for relationship in _xml(data).iter(_q(PKG_REL, "Relationship")):
        if relationship.get("TargetMode") == "External":
            continue
        name = _part_name(base, relationship.get("Target"))
        member = archive.find(name)
        if member is not None:
            found.append(_Relationship(relationship.get("Id"), relationship.get("Type") or "", name, member))
    return found


def _first_relationship(relationships, type_suffix):
    return next((relationship for relationship in relationships if relationship.type.endswith(type_suffix)), None)


# --- docx -------------------------------------------------------------------------------------


def _heading_level(style_name):
    name = " ".join((style_name or "").split()).casefold()
    if name == "title":
        return 1
    if name == "subtitle":
        return 2
    compact = name.replace(" ", "")
    if compact.startswith("heading") and compact[len("heading") :].isdigit():
        return max(1, min(int(compact[len("heading") :]), 4))
    return 0


def _docx_heading_styles(archive):
    data = _read_part(archive, "word/styles.xml", required=False)
    if not data:
        return {}
    levels = {}
    for style in _xml(data).iter(_q(W, "style")):
        style_id = style.get(_q(W, "styleId"))
        name = style.find(_q(W, "name"))
        level = _heading_level(name.get(W_VAL) if name is not None else "")
        if style_id and level:
            levels[style_id] = level
    return levels


def _run_texts(element, out):
    for child in element:
        tag = child.tag
        if not isinstance(tag, str) or tag in W_SKIPPED:
            continue
        if tag == W_T:
            out.append(child.text or "")
        elif tag == W_TAB:
            out.append("\t")
        elif tag in (W_BR, W_CR):
            out.append("\n")
        elif tag == W_NBH:
            out.append("-")
        else:
            _run_texts(child, out)


def _paragraph_text(paragraph):
    out = []
    _run_texts(paragraph, out)
    return "".join(out).strip()


def _docx_blocks(container):
    for child in container:
        if child.tag in (W_P, W_TBL):
            yield child
        elif child.tag in W_CONTAINERS:
            yield from _docx_blocks(child)


def _nested_texts(element):
    texts = []
    for child in element:
        if child.tag == W_P:
            text = _paragraph_text(child)
            if text:
                texts.append(text)
        elif child.tag in (W_TBL, W_TR, W_TC) or child.tag in W_CONTAINERS:
            texts.extend(_nested_texts(child))
    return texts


def _docx_table(table, budget):
    rows = [child for child in table if child.tag == W_TR]
    if len(rows) > DOCX_TABLE_MAX_ROWS:
        budget.truncated = True
    rows_html = []
    for row in rows[:DOCX_TABLE_MAX_ROWS]:
        cells = [child for child in row if child.tag == W_TC]
        if len(cells) > DOCX_TABLE_MAX_COLS:
            budget.truncated = True
        cells_html = []
        for cell in cells[:DOCX_TABLE_MAX_COLS]:
            text = budget.take("\n".join(_nested_texts(cell)), CELL_MAX_CHARS)
            if text is None:
                break
            cells_html.append(f"<td>{_escape(text)}</td>")
        if cells_html:
            rows_html.append(f"<tr>{''.join(cells_html)}</tr>")
        if budget.chars_left <= 0:
            break
    return f"<table><tbody>{''.join(rows_html)}</tbody></table>" if rows_html else ""


def _docx_payload(raw, limits):
    budget = _Budget(limits)
    with _open_archive(raw, limits) as archive:
        document = _read_part(archive, "word/document.xml")
        heading_styles = _docx_heading_styles(archive)
    body = _xml(document).find(W_BODY)
    if body is None:
        raise PreviewRejected("invalid")
    parts = []
    list_open = False
    block_count = 0
    for block in _docx_blocks(body):
        # Checked on every block regardless of content, so a flood of empty paragraphs (which
        # do not count toward DOCX_MAX_BLOCKS below) still cannot run past the time budget.
        if budget.expired():
            budget.truncated = True
            break
        if block.tag == W_TBL:
            block_count += 1
            if block_count > DOCX_MAX_BLOCKS:
                budget.truncated = True
                break
            if list_open:
                parts.append("</ul>")
                list_open = False
            parts.append(_docx_table(block, budget))
            continue
        text = _paragraph_text(block)
        if not text:
            # An empty paragraph (e.g. a blank line) produces no output, so it should not count
            # against the visible-content cap: a real document with many blank lines should not
            # be truncated any earlier than one without them.
            continue
        block_count += 1
        if block_count > DOCX_MAX_BLOCKS:
            budget.truncated = True
            break
        text = budget.take(text)
        if text is None:
            break
        level = 0
        is_list_item = False
        properties = block.find(W_PPR)
        if properties is not None:
            style = properties.find(W_PSTYLE)
            if style is not None:
                style_id = style.get(W_VAL) or ""
                level = heading_styles.get(style_id) or _heading_level(style_id)
            is_list_item = properties.find(W_NUMPR) is not None
        if is_list_item and not level:
            if not list_open:
                parts.append("<ul>")
                list_open = True
            parts.append(f"<li>{_escape(text)}</li>")
            continue
        if list_open:
            parts.append("</ul>")
            list_open = False
        tag = f"h{level}" if level else "p"
        parts.append(f"<{tag}>{_escape(text)}</{tag}>")
    if list_open:
        parts.append("</ul>")
    return {"kind": "docx", "html": _sanitize("".join(parts)), "truncated": budget.truncated}


# --- xlsx -------------------------------------------------------------------------------------


def _cell_text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 1e15 else f"{value:.15g}"
    if isinstance(value, datetime.datetime):
        if value.time() == datetime.time(0, 0):
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    return str(value)


def _rectangular_rows(rows):
    while rows and not any(rows[-1]):
        rows.pop()
    width = 0
    for row in rows:
        for index, cell in enumerate(row):
            if cell:
                width = max(width, index + 1)
    return [(row + [""] * width)[:width] for row in rows]


_XLSX_STYLES_HEAD = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{S}">'
    '<fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
)
_XLSX_STYLES_TAIL = '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'


def _xlsx_package(archive, budget):
    """Build the only package openpyxl gets to see (see the module docstring for why).

    Every part is found through relationships — the package's officeDocument relationship, then
    the workbook's own — never by member name, and read once through the capped reader that
    charges the running budget. Copied as stored: the worksheet parts of the first
    ``XLSX_MAX_WORKBOOK_SHEETS`` distinct worksheets, the shared strings and the theme. Generated
    here: content types, both relationship parts, a workbook part with only the date system and
    one ``<sheet>`` per kept worksheet part, and styles reduced to which cell formats are dates.
    Nothing else in the upload is read.
    """
    workbook = _first_relationship(_relationships(archive, "", budget), "/officeDocument")
    if workbook is None:
        raise PreviewRejected("invalid")
    workbook_rels = _relationships(archive, workbook.name, budget)
    date1904, sheets = _xlsx_workbook_sheets(archive, workbook.member, workbook_rels, budget)
    parts = []
    for index, (_, _, member) in enumerate(sheets, start=1):
        budget.check()
        parts.append((f"worksheets/sheet{index}.xml", "worksheet", _read_member(archive, member)))
    shared_strings = _first_relationship(workbook_rels, "/sharedStrings")
    shared_strings = shared_strings.member if shared_strings else _xlsx_declared_part(archive, "sharedStrings", budget)
    if shared_strings is not None:
        budget.check()
        parts.append(("sharedStrings.xml", "sharedStrings", _read_member(archive, shared_strings)))
    styles = _first_relationship(workbook_rels, "/styles")
    if styles is not None:
        budget.check()
        cell_formats = _xlsx_styles(_read_member(archive, styles.member), budget)
        if cell_formats is not None:
            parts.append(("styles.xml", "styles", cell_formats))
    theme = _first_relationship(workbook_rels, "/theme")
    if theme is not None:
        budget.check()
        parts.append(("theme/theme1.xml", "theme", _read_member(archive, theme.member)))
    return _xlsx_zip(date1904, sheets, parts)


def _xlsx_zip(date1904, sheets, parts):
    """Write the rebuilt package; ``parts`` are ``(name under xl/, kind, data)``, worksheets first."""
    workbook = etree.Element(_q(S, "workbook"), nsmap={None: S, "r": R})
    if date1904:
        etree.SubElement(workbook, _q(S, "workbookPr"), date1904="1")
    sheets_element = etree.SubElement(workbook, _q(S, "sheets"))
    for index, (name, state, _) in enumerate(sheets, start=1):
        sheet = etree.SubElement(sheets_element, _q(S, "sheet"), name=name, sheetId=str(index))
        if state in ("visible", "hidden", "veryHidden"):
            sheet.set("state", state)
        sheet.set(_q(R, "id"), f"rId{index}")  # worksheets come first in ``parts``: rId<n> is sheet n
    overrides = "".join(
        f'<Override PartName="/xl/{name}" ContentType="{XLSX_TYPES[kind]}"/>'
        for name, kind, _ in [("workbook.xml", "workbook", None), *parts]
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as out:
        out.writestr(
            "[Content_Types].xml",
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="{CONTENT_TYPES}">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            f'<Default Extension="xml" ContentType="application/xml"/>{overrides}</Types>',
        )
        out.writestr("_rels/.rels", _xlsx_relationships([("officeDocument", "xl/workbook.xml")]))
        out.writestr("xl/workbook.xml", etree.tostring(workbook, xml_declaration=True, encoding="UTF-8"))
        out.writestr("xl/_rels/workbook.xml.rels", _xlsx_relationships([(kind, name) for name, kind, _ in parts]))
        for name, _, data in parts:
            out.writestr(f"xl/{name}", data)
    buffer.seek(0)
    return buffer


def _xlsx_relationships(targets):
    relationships = "".join(
        f'<Relationship Id="rId{index}" Type="{R}/{kind}" Target="{target}"/>'
        for index, (kind, target) in enumerate(targets, start=1)
    )
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PKG_REL}">{relationships}</Relationships>'
    )


def _xlsx_workbook_sheets(archive, workbook_member, workbook_rels, budget):
    """The date system, and ``(name, state, member)`` of the first ``XLSX_MAX_WORKBOOK_SHEETS``
    distinct worksheet parts in workbook order (a part referenced by several ``<sheet>`` entries
    counts once; chartsheets, dialog/macro sheets and dangling references hold no cell values)."""
    by_id = {}
    for relationship in workbook_rels:
        if relationship.id:
            by_id.setdefault(relationship.id, relationship)
    budget.check()
    root = _xml(_read_member(archive, workbook_member))
    date1904 = False
    sheets = []
    seen = set()
    for child in root:
        local = _localname(child)
        if local == "workbookPr":
            date1904 = (child.get("date1904") or "").strip().casefold() in ("1", "true")
        elif local == "sheets":
            for sheet in child:
                if _localname(sheet) != "sheet":
                    continue
                budget.check()
                relationship = by_id.get(sheet.get(_q(R, "id")))
                if relationship is None or not relationship.type.endswith("/worksheet"):
                    continue
                key = _part_key(relationship.name)
                if key in seen:
                    continue
                if len(sheets) == XLSX_MAX_WORKBOOK_SHEETS:
                    budget.truncated = True
                    break
                seen.add(key)
                sheets.append((sheet.get("name") or "", sheet.get("state"), relationship.member))
    return date1904, sheets


def _xlsx_declared_part(archive, kind, budget):
    """The first part ``[Content_Types].xml`` declares as ``kind``.

    Used only for the shared strings: openpyxl itself locates them this way, so the workbooks it
    writes (pandas exports included) have no workbook relationship for them.
    """
    budget.check()
    data = _read_part(archive, "[Content_Types].xml", required=False)
    if data is None:
        return None
    for override in _xml(data).iter(_q(CONTENT_TYPES, "Override")):
        if override.get("ContentType") == XLSX_TYPES[kind]:
            return archive.find(_part_name("", override.get("PartName")))
    return None


def _xlsx_styles(data, budget):
    """Styles reduced to what a values preview reads: which cell formats are dates.

    A cell's ``s`` attribute indexes ``cellXfs``, and openpyxl turns a number into a date when that
    entry's number format is a date format; nothing else in the styles part matters for values.
    Each entry is rewritten as built-in format 14 (a date) or 0 (General), decided once per
    distinct format with openpyxl's own ``is_date_format``, so openpyxl never parses named styles
    (each expanded against the whole custom-format list: quadratic), fonts, fills or borders, and
    never re-scans a format code once per cell format. Returns None when there are no cell formats.
    """
    from openpyxl.styles.numbers import builtin_format_code, is_date_format

    custom = {}
    format_ids = []
    for child in _xml(data):
        local = _localname(child)
        if local == "numFmts":
            custom = {
                int(number_format.get("numFmtId")): number_format.get("formatCode") or ""
                for number_format in child
                if _localname(number_format) == "numFmt" and number_format.get("numFmtId") is not None
            }
        elif local == "cellXfs":
            format_ids = [int(xf.get("numFmtId") or 0) for xf in child if _localname(xf) == "xf"]
    if not format_ids:
        return None
    if len(format_ids) > XLSX_MAX_CELL_FORMATS:
        raise PreviewRejected("limits")
    is_date = {}
    for format_id in format_ids:
        if format_id not in is_date:
            budget.check()
            code = custom[format_id] if format_id in custom else builtin_format_code(format_id)
            if code is not None and len(code) > XLSX_NUMBER_FORMAT_MAX_CHARS:
                raise PreviewRejected("limits")
            is_date[format_id] = is_date_format(code)
    cell_formats = "".join('<xf numFmtId="14"/>' if is_date[fid] else '<xf numFmtId="0"/>' for fid in format_ids)
    return f'{_XLSX_STYLES_HEAD}<cellXfs count="{len(format_ids)}">{cell_formats}</cellXfs>{_XLSX_STYLES_TAIL}'


def _xlsx_sheet_name(name, budget):
    """Cap a worksheet's display name and charge it to the output budget.

    Unlike every other piece of text in the xlsx payload, ``worksheet.title`` never passed through
    ``budget.take``: a sheet name has no size limit of its own (Excel's UI caps it at 31 characters,
    but a forged or foreign workbook is not bound by that), so a single very long name could reach
    the response well past ``output_max_chars`` — and get cached alongside it. Cutting it to
    ``XLSX_SHEET_NAME_MAX_CHARS`` characters plus an ellipsis first bounds how much of the budget one
    name can ever consume; ``take`` then still applies if little budget is left.
    """
    name = name or ""
    if len(name) > XLSX_SHEET_NAME_MAX_CHARS:
        name = name[:XLSX_SHEET_NAME_MAX_CHARS] + "…"
        budget.truncated = True
    return budget.take(name) or ""


def _xlsx_payload(raw, limits):
    from openpyxl import load_workbook

    budget = _Budget(limits)
    with _open_archive(raw, limits) as archive:
        package = _xlsx_package(archive, budget)
    workbook = load_workbook(package, read_only=True, data_only=True, keep_links=False)
    try:
        visible = [sheet for sheet in workbook.worksheets if getattr(sheet, "sheet_state", "visible") == "visible"]
        worksheets = visible or workbook.worksheets[:1]
        if len(worksheets) > XLSX_MAX_SHEETS:
            budget.truncated = True
        sheets = []
        for worksheet in worksheets[:XLSX_MAX_SHEETS]:
            rows = []
            for row_index, row in enumerate(
                worksheet.iter_rows(
                    min_row=1,
                    max_row=XLSX_MAX_ROWS + 1,
                    max_col=XLSX_MAX_COLS + 1,
                    values_only=True,
                )
            ):
                if row_index >= XLSX_MAX_ROWS:
                    if any(value is not None for value in row):
                        budget.truncated = True
                    break
                if any(value is not None for value in row[XLSX_MAX_COLS:]):
                    budget.truncated = True
                cells = []
                for value in row[:XLSX_MAX_COLS]:
                    text = budget.take(_cell_text(value), CELL_MAX_CHARS)
                    if text is None:
                        break
                    cells.append(text)
                rows.append(cells)
                if budget.chars_left <= 0 or budget.expired():
                    break
            sheets.append({"name": _xlsx_sheet_name(worksheet.title, budget), "rows": _rectangular_rows(rows)})
            if budget.chars_left <= 0 or budget.expired():
                break
    finally:
        workbook.close()
    return {"kind": "xlsx", "sheets": sheets, "truncated": budget.truncated}


# --- pptx -------------------------------------------------------------------------------------


def _drawing_paragraph(paragraph):
    return "".join("\n" if node.tag == A_BR else (node.text or "") for node in paragraph.iter(A_T, A_BR)).strip()


def _slide_text(slide):
    title_parts = []
    body_parts = []
    for shape in slide.iter(_q(P, "sp"), _q(P, "graphicFrame")):
        if shape.tag == _q(P, "graphicFrame"):
            for cell in shape.iter(A_TC):
                text = " ".join(filter(None, (_drawing_paragraph(p) for p in cell.iter(A_P))))
                if text:
                    body_parts.append(text)
            continue
        placeholder = shape.find(f"{_q(P, 'nvSpPr')}/{_q(P, 'nvPr')}/{_q(P, 'ph')}")
        is_title = placeholder is not None and placeholder.get("type") in {"title", "ctrTitle"}
        text_body = shape.find(_q(P, "txBody"))
        if text_body is None:
            continue
        paragraphs = [text for text in (_drawing_paragraph(p) for p in text_body.iter(A_P)) if text]
        (title_parts if is_title else body_parts).extend(paragraphs)
    return " ".join(title_parts), "\n".join(body_parts)


def _pptx_payload(raw, limits):
    budget = _Budget(limits)
    slides = []
    with _open_archive(raw, limits) as archive:
        presentation = _xml(_read_part(archive, "ppt/presentation.xml"))
        relationships = _xml(_read_part(archive, "ppt/_rels/presentation.xml.rels"))
        targets = {}
        for relationship in relationships.iter(_q(PKG_REL, "Relationship")):
            if relationship.get("TargetMode") == "External" or not relationship.get("Type", "").endswith("/slide"):
                continue
            part = _part_name("ppt", relationship.get("Target"))
            if part:
                targets[relationship.get("Id")] = part
        order = [slide_id.get(_q(R, "id")) for slide_id in presentation.iter(_q(P, "sldId"))]
        if len(order) > PPTX_MAX_SLIDES:
            budget.truncated = True
        for index, relationship_id in enumerate(order[:PPTX_MAX_SLIDES], start=1):
            if budget.expired():
                break
            data = _read_part(archive, targets.get(relationship_id), required=False)
            if data is None:
                continue
            title, text = _slide_text(_xml(data))
            title = budget.take(title, SLIDE_TITLE_MAX_CHARS)
            text = budget.take(text, SLIDE_TEXT_MAX_CHARS) if title is not None else None
            if title is None or text is None:
                break
            slides.append({"index": index, "title": title, "text": text})
    return {"kind": "pptx", "slides": slides, "truncated": budget.truncated}
