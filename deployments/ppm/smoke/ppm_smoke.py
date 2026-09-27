#!/usr/bin/env python3
"""PPM post-deploy smoke (release candidate).

Runs inside the deployment network with the PPM API image (``ppm-deploy.sh smoke <mode>``), talks to the public
HTTPS URL exactly like a browser: CSRF token, Origin/Referer, secure cookies, presigned object URLs through the
proxy and the Canvas WebSocket (wss) with the session cookie.

Modes
  bootstrap-account       EMPTY test instance only: test instance admin + test user; writes the state file.
  bootstrap-data          (after ppm-deploy.sh granted the global administrator role) workspace, project, Work Item
                          with attachment, board with versions, Vault file with versions + PDF, Brain reindex/search,
                          WebSocket presence and board-changed event. ``ppm-deploy.sh smoke bootstrap`` runs all three.
  verify                  signs in with the stored test user and re-checks every stored fact (read-only).
  extend <label>          writes new data on top (Work Item, board version, Vault version) and records it.
  expect-missing-objects  negative restore check: database facts must pass, object downloads must FAIL.
  measure-300             server-side numbers for a 300-shape board (payload size, save/load latency, WS event).
  probe                   failure injection helper: tries the main user operations and prints what the user gets
                          (HTTP status, API error code and message) without asserting; exit 0.
  log-probe               credential-bearing URLs (password reset, invitation, OAuth callback, tokens in queries,
                          referer, live WebSocket cookie) through api, web, admin, space and live with planted
                          one-time values; every value is recorded so ``ppm-deploy.sh scan-logs`` proves that none
                          of them reached any log.

The state file contains TEST credentials only (mode 600, git-ignored runtime directory). Output never contains
passwords, cookies or presigned URLs; the scan-logs step reads ``sensitive-values.txt`` to prove they never
reach the service logs either.
"""

import hashlib
import json
import os
import re
import secrets
import ssl
import statistics
import string
import sys
import time
import uuid
from urllib.parse import urlparse

import requests
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect as ws_connect

BASE = os.environ["PPM_PUBLIC_URL"].rstrip("/")
PUBLIC = urlparse(BASE)
CA_BUNDLE = os.environ.get("PPM_SMOKE_CA_BUNDLE") or None
STATE_PATH = os.environ.get("PPM_SMOKE_STATE", "/state/smoke-state.json")
SENSITIVE_PATH = os.path.join(os.path.dirname(STATE_PATH), "sensitive-values.txt")
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a5b00000000049454e44ae426082"
)


def make_pdf(text):
    """Smallest valid one-page PDF with real text (Brain extracts it), correct xref offsets."""
    stream = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode()
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(bodies, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(bodies) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(bodies) + 1, xref)
    return bytes(out)


class SmokeError(Exception):
    pass


def sanitize(text):
    """Failure texts may quote URLs (requests exceptions): drop query strings — presigned URLs carry signatures."""
    return re.sub(r"\?[^\s'\"<>)]*", "?…", str(text))[:400]


class Report:
    def __init__(self, mode):
        self.mode = mode
        self.results = []

    def check(self, name, func, *, expect_failure=False):
        started = time.monotonic()
        try:
            detail = func()
        except Exception as error:  # noqa: BLE001 - every failure is reported, the run continues
            ok = expect_failure
            detail = sanitize(f"{type(error).__name__}: {error}")
        else:
            ok = not expect_failure
            if expect_failure:
                detail = f"UNEXPECTED SUCCESS ({detail})"
        elapsed = round((time.monotonic() - started) * 1000)
        label = "ok  " if ok else "FAIL"
        suffix = f" — {detail}" if detail else ""
        print(f"[{label}] {name} ({elapsed} ms){suffix}", flush=True)
        self.results.append({"check": name, "ok": ok, "ms": elapsed})
        return ok

    def finish(self, extra=None):
        failed = [r["check"] for r in self.results if not r["ok"]]
        summary = {"mode": self.mode, "checks": len(self.results), "failed": failed, "public_url": BASE}
        if extra:
            summary.update(extra)
        print("SMOKE_RESULT " + json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
        sys.exit(1 if failed else 0)


def canonical_hash(snapshot):
    encoded = json.dumps(snapshot, allow_nan=False, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def token(length=10):
    return "".join(secrets.choice(string.ascii_lowercase) for _ in range(length))


def password():
    return "Ppm!" + secrets.token_urlsafe(18) + "9a"


class Client:
    def __init__(self):
        self.session = requests.Session()
        self.session.verify = CA_BUNDLE or True
        self.session.headers.update({"Accept": "application/json, text/plain, */*", "User-Agent": "ppm-rc-smoke/1"})
        self.csrf_token = ""

    def url(self, path):
        return path if path.startswith("http") else BASE + path

    def csrf(self):
        response = self.session.get(self.url("/auth/get-csrf-token/"), timeout=30)
        if response.status_code != 200:
            raise SmokeError(f"CSRF endpoint returned {response.status_code}")
        self.csrf_token = response.json()["csrf_token"]

    def request(self, method, path, *, expected=(200,), headers=None, **kwargs):
        headers = dict(headers or {})
        if method not in ("GET", "HEAD", "OPTIONS") and not path.startswith("http"):
            headers.setdefault("X-CSRFToken", self.csrf_token)
            headers.setdefault("Origin", BASE)
            headers.setdefault("Referer", BASE + "/")
        response = self.session.request(
            method, self.url(path), headers=headers, allow_redirects=False, timeout=60, **kwargs
        )
        if response.status_code not in expected:
            excerpt = " ".join(response.text.split())[:200]
            raise SmokeError(
                f"{method} {urlparse(self.url(path)).path} -> {response.status_code}, expected {expected}: {excerpt}"
            )
        return response

    def json(self, method, path, payload=None, *, expected=(200,)):
        return self.request(method, path, json=payload, expected=expected).json()

    def json_multipart(self, method, path, files, *, data=None, expected=(200,)):
        return self.request(method, path, files=files, data=data or {}, expected=expected).json()

    def csrf_cookie_is_secure(self):
        response = self.session.get(self.url("/auth/get-csrf-token/"), timeout=30)
        attributes = set_cookie_attributes(response, "csrftoken")
        if attributes and "secure" not in attributes:
            raise SmokeError(f"CSRF cookie attributes are {sorted(attributes)}, Secure is missing")
        return "CSRF cookie Secure" if attributes else "CSRF cookie already set (not re-issued)"

    def cookie_header(self):
        return "; ".join(f"{cookie.name}={cookie.value}" for cookie in self.session.cookies)

    def download_via_redirect(self, path):
        """API returns a redirect to a presigned URL; the URL must point at the public origin (proxy → MinIO)."""
        response = self.request("GET", path, expected=(301, 302, 303, 307))
        location = response.headers.get("Location", "")
        target = urlparse(location)
        if (target.scheme, target.hostname, target.port) != (PUBLIC.scheme, PUBLIC.hostname, PUBLIC.port):
            raise SmokeError(f"presigned URL points to {target.scheme}://{target.netloc}, not the public origin")
        blob = requests.get(location, timeout=60, verify=CA_BUNDLE or True, allow_redirects=False)
        if blob.status_code != 200:
            raise SmokeError(f"presigned download returned {blob.status_code}")
        return blob.content


def remember_sensitive(*values):
    with open(SENSITIVE_PATH, "a", encoding="utf-8") as handle:
        for value in values:
            if value and len(value) >= 8:
                handle.write(value + "\n")
    os.chmod(SENSITIVE_PATH, 0o600)


def load_state():
    with open(STATE_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def save_state(state):
    temporary = STATE_PATH + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE_PATH)


def set_cookie_attributes(response, name):
    raw = getattr(response.raw, "headers", None)
    values = raw.getlist("Set-Cookie") if raw is not None and hasattr(raw, "getlist") else []
    for value in values:
        if value.split("=", 1)[0].strip() == name:
            return {part.strip().split("=", 1)[0].lower() for part in value.split(";")[1:]}
    return set()


def sign_in(client, email, secret):
    client.csrf()
    response = client.request(
        "POST", "/auth/sign-in/", data={"email": email, "password": secret}, expected=(301, 302, 303)
    )
    if "error_code" in response.headers.get("Location", ""):
        raise SmokeError("sign-in rejected")
    if not client.session.cookies.get("session-id"):
        raise SmokeError("sign-in did not create a session")
    attributes = set_cookie_attributes(response, "session-id")
    if not {"secure", "httponly"} <= attributes:
        raise SmokeError(f"session cookie attributes are {sorted(attributes)}, need Secure and HttpOnly")
    client.csrf()
    remember_sensitive(client.session.cookies.get("session-id"), client.session.cookies.get("csrftoken"))
    return "session cookie Secure+HttpOnly"


def api(state):
    return f"/api/workspaces/{state['workspace_slug']}/projects/{state['project_id']}"


def ppm(state):
    return f"/api/ppm/v1/workspaces/{state['workspace_id']}/projects/{state['project_id']}"


def snapshot(label, shapes):
    """A tldraw-shaped document: every shape carries the fields of a real tldraw 3 geo shape (~0.6 KB each)."""
    store = {"page:page": {"id": "page:page", "typeName": "page", "name": "Page 1", "index": "a1", "meta": {}}}
    for index in range(shapes):
        shape_id = f"shape:rc-{label}-{index}"
        text = f"{label} {index}"
        store[shape_id] = {
            "id": shape_id,
            "typeName": "shape",
            "type": "geo",
            "parentId": "page:page",
            "index": f"a{index + 2}",
            "x": (index % 20) * 140,
            "y": (index // 20) * 100,
            "rotation": 0,
            "isLocked": False,
            "opacity": 1,
            "meta": {},
            "props": {
                "geo": "rectangle",
                "w": 120,
                "h": 80,
                "color": "black",
                "labelColor": "black",
                "fill": "semi",
                "dash": "draw",
                "size": "m",
                "font": "draw",
                "align": "middle",
                "verticalAlign": "middle",
                "growY": 0,
                "url": "",
                "scale": 1,
                "richText": {
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
                },
            },
        }
    return {"document": {"store": store, "schema": {"schemaVersion": 2, "sequences": {}}}, "session": {}}


def save_board(client, state, board, snap):
    payload = {
        "schema_version": 2,
        "base_version": board["latest"],
        "snapshot": snap,
        "client_operation_id": str(uuid.uuid4()),
    }
    saved = client.json("PUT", f"{ppm(state)}/canvas/boards/{board['id']}/snapshot/", payload)
    if saved["content_hash"] != canonical_hash(snap):
        raise SmokeError("server content hash differs from the local canonical hash")
    board["versions"][str(saved["version"])] = saved["content_hash"]
    board["latest"] = saved["version"]
    return saved


def upload_vault_file(client, state, name, content, *, entry_id=None, base_version=None):
    files = {"file": (name, content, "text/plain")}
    if entry_id is None:
        return client.json_multipart("POST", f"{ppm(state)}/vault/files/", files, expected=(201,))
    return client.json_multipart(
        "PUT", f"{ppm(state)}/vault/entries/{entry_id}/file/", files, data={"base_version": str(base_version)}
    )


def ws_uri(state, board_id):
    base = BASE.replace("https://", "wss://", 1)
    room = f"workspaces/{state['workspace_id']}/projects/{state['project_id']}/canvas/boards/{board_id}"
    return f"{base}/ws/ppm/v1/{room}/presence/"


def ssl_context():
    return ssl.create_default_context(cafile=CA_BUNDLE) if CA_BUNDLE else ssl.create_default_context()


def ws_receive(ws, wanted_type, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SmokeError(f"no {wanted_type} within {timeout}s")
        message = json.loads(ws.recv(timeout=remaining))
        if message.get("type") == wanted_type:
            return message


def ws_presence(client, state, *, write_while_connected=False):
    board = state["board"]
    with ws_connect(
        ws_uri(state, board["id"]),
        additional_headers={"Cookie": client.cookie_header(), "Origin": BASE},
        ssl=ssl_context(),
        open_timeout=20,
    ) as ws:
        ready = ws_receive(ws, "presence.ready")
        if ready.get("board_version") != board["latest"]:
            raise SmokeError(f"presence.ready board_version {ready.get('board_version')} != {board['latest']}")
        ws.send(json.dumps({"type": "presence.heartbeat"}))
        ws_receive(ws, "presence.heartbeat_ack")
        if not write_while_connected:
            return f"presence.ready v{ready['board_version']}, heartbeat ack"
        started = time.monotonic()
        saved = save_board(client, state, board, snapshot(f"ws-{token(4)}", 3))
        event = ws_receive(ws, "canvas.board.changed")
        if event.get("version") != saved["version"]:
            raise SmokeError(f"canvas.board.changed version {event.get('version')} != {saved['version']}")
        return f"canvas.board.changed v{saved['version']} in {round((time.monotonic() - started) * 1000)} ms"


def ws_rejected(state, *, origin, cookies):
    try:
        with ws_connect(
            ws_uri(state, state["board"]["id"]),
            additional_headers={"Origin": origin, **({"Cookie": cookies} if cookies else {})},
            ssl=ssl_context(),
            open_timeout=20,
        ) as ws:
            first = json.loads(ws.recv(timeout=5))
            raise SmokeError(f"connection accepted ({first.get('type')})")
    except InvalidStatus as error:
        return f"handshake refused with HTTP {error.response.status_code}"


def brain_reindex(client, state, timeout=90):
    """Re-index every project source (Work Items, Vault files, ...); every job must reach `ready`."""
    queued = client.json("POST", f"{ppm(state)}/knowledge/reindex/", {}, expected=(202,))
    deadline = time.monotonic() + timeout
    pending, dead = set(queued.get("job_ids", [])), []
    while pending and time.monotonic() < deadline:
        for job_id in list(pending):
            job = client.json("GET", f"{ppm(state)}/knowledge/jobs/{job_id}/")
            if job["status"] in ("ready", "superseded"):
                pending.discard(job_id)
            elif job["status"] == "dead":
                pending.discard(job_id)
                dead.append(job.get("error_code") or "unknown")
        if pending:
            time.sleep(2)
    total = len(queued.get("job_ids", []))
    if pending or dead:
        raise SmokeError(f"{total} jobs: {len(pending)} still running after {timeout}s, dead={dead}")
    return f"{total} index jobs ready"


def brain_golden_search(client, state):
    found = client.json("POST", f"{ppm(state)}/knowledge/query/", {"query": state["golden"], "top_k": 5})
    hits = json.dumps(found.get("results", []), ensure_ascii=False)
    if state["issues"][0]["id"] not in hits and state["golden"] not in hits:
        raise SmokeError(f"search for the golden token found no Work Item ({len(found.get('results', []))} results)")
    return f"{len(found['results'])} results, golden Work Item found"


def brain_checks(report, client, state):
    if os.environ.get("PPM_SMOKE_NO_WORKERS") == "1":
        # Restore-drill copies run without worker/beat (no e-mails from a copy of real data): nothing would process
        # a reindex, so only the restored index is searched.
        print("[skip] Brain reindex: no background workers in this copy (restore drill)", flush=True)
    else:
        report.check("Brain reindex: every index job finishes", lambda: brain_reindex(client, state))
    report.check("Brain search: golden token finds the Work Item", lambda: brain_golden_search(client, state))


# ---------------------------------------------------------------------------------------------------- checks


def verify_database_facts(report, client, state):
    report.check(
        "workspace readable",
        lambda: _check_id(client, f"/api/workspaces/{state['workspace_slug']}/", state["workspace_id"]),
    )
    report.check("project readable", lambda: _check_id(client, f"{api(state)}/", state["project_id"]))
    for issue in state["issues"]:
        report.check(
            f"Work Item '{issue['name'][:24]}' readable", lambda issue=issue: _check_issue(client, state, issue)
        )
    report.check("board: current version and content", lambda: _check_board_current(client, state))
    report.check("board: every stored version (old ones too)", lambda: _check_board_versions(client, state))
    report.check("Vault: version list and hashes", lambda: _check_vault_versions(client, state))


def verify_object_facts(report, client, state, *, expect_failure=False):
    report.check(
        "attachment download (presigned via proxy)",
        lambda: _check_attachment(client, state),
        expect_failure=expect_failure,
    )
    for version, digest in sorted(state["vault"]["file"]["versions"].items(), key=lambda item: int(item[0])):
        report.check(
            f"Vault file v{version} download",
            lambda version=version, digest=digest: _check_vault_download(client, state, version, digest),
            expect_failure=expect_failure,
        )
    report.check(
        "Vault PDF (iframe path) download", lambda: _check_vault_pdf(client, state), expect_failure=expect_failure
    )
    report.check(
        "Vault preview (server-side read from object storage)",
        lambda: _check_vault_preview(client, state),
        expect_failure=expect_failure,
    )


def _fail(message):
    raise SmokeError(message)


def _check_id(client, path, expected_id):
    if client.json("GET", path)["id"] != expected_id:
        raise SmokeError("identity changed")
    return ""


def _check_issue(client, state, issue):
    data = client.json("GET", f"{api(state)}/issues/{issue['id']}/")
    if data["id"] != issue["id"] or data["name"] != issue["name"]:
        raise SmokeError("Work Item content changed")
    return f"attachments={data.get('attachment_count')}"


def _check_board_current(client, state):
    board = state["board"]
    data = client.json("GET", f"{ppm(state)}/canvas/boards/{board['id']}/")
    if data["version"] != board["latest"] or data["content_hash"] != board["versions"][str(board["latest"])]:
        raise SmokeError(f"board is at v{data['version']} ({data.get('snapshot_status')}), expected v{board['latest']}")
    if data.get("snapshot_status") == "corrupt":
        raise SmokeError("board snapshot is corrupt")
    return f"v{data['version']} hash ok"


def _check_board_versions(client, state):
    board = state["board"]
    listed = client.json("GET", f"{ppm(state)}/canvas/boards/{board['id']}/versions/")["versions"]
    listed_numbers = {item["version"] for item in listed}
    for version, digest in board["versions"].items():
        if int(version) not in listed_numbers:
            raise SmokeError(f"version {version} missing from the list")
        detail = client.json("GET", f"{ppm(state)}/canvas/boards/{board['id']}/versions/{version}/")
        if canonical_hash(detail["snapshot"]) != digest:
            raise SmokeError(f"version {version} content changed")
    return f"{len(board['versions'])} versions match"


def _check_vault_versions(client, state):
    entry = state["vault"]["file"]
    data = client.json("GET", f"{ppm(state)}/vault/entries/{entry['id']}/versions/")
    listed = {str(item["version"]): item["content_hash"] for item in data["versions"]}
    for version, digest in entry["versions"].items():
        if listed.get(version) != digest:
            raise SmokeError(f"Vault version {version} hash differs")
    if data["entry"]["version"] != entry["latest"]:
        raise SmokeError("Vault current version changed")
    return f"{len(entry['versions'])} versions, current v{entry['latest']}"


def _check_attachment(client, state):
    attachment = state["attachment"]
    content = client.download_via_redirect(
        f"/api/assets/v2/workspaces/{state['workspace_slug']}/projects/{state['project_id']}/{attachment['asset_id']}/"
    )
    if sha256(content) != attachment["sha256"]:
        raise SmokeError("attachment bytes differ")
    return "bytes match"


def _check_vault_download(client, state, version, digest):
    entry = state["vault"]["file"]
    path = (
        f"{ppm(state)}/vault/entries/{entry['id']}/file/"
        if int(version) == entry["latest"]
        else f"{ppm(state)}/vault/entries/{entry['id']}/versions/{version}/"
    )
    content = client.download_via_redirect(path)
    if sha256(content) != digest:
        raise SmokeError("Vault bytes differ")
    return "bytes match"


def _check_vault_preview(client, state):
    entry = state["vault"]["file"]
    data = client.json("GET", f"{ppm(state)}/vault/entries/{entry['id']}/preview/")
    if state["golden"] not in json.dumps(data, ensure_ascii=False):
        raise SmokeError(f"preview has no file text (keys: {sorted(data)[:6]})")
    return "server read the current version from object storage"


def _check_vault_pdf(client, state):
    pdf = state["vault"]["pdf"]
    content = client.download_via_redirect(f"{ppm(state)}/vault/entries/{pdf['id']}/pdf/")
    if sha256(content) != pdf["sha256"]:
        raise SmokeError("PDF bytes differ")
    return "bytes match"


# ---------------------------------------------------------------------------------------------------- modes


def mode_bootstrap(report, phase):
    """Phase `account`: test instance admin + test user. Between the phases ppm-deploy.sh grants the test user the PPM
    global administrator role (`manage.py ppm_global_admin grant --bootstrap`) — only it may create projects.
    Phase `data`: everything else."""
    anonymous = Client()
    if phase == "account":
        if os.path.exists(STATE_PATH):
            _fail(f"{STATE_PATH} already exists; bootstrap only runs once per test instance")
        instance = anonymous.json("GET", "/api/instances/")
        claimed_path = os.path.join(os.path.dirname(STATE_PATH), "admin-credentials.json")
        claimed = bool(instance.get("is_setup_done")) or os.path.exists(claimed_path)
        if claimed:
            # Instance already claimed with `ppm-deploy.sh claim-admin` (test stand: its credentials file).
            if not os.path.exists(claimed_path):
                _fail("instance is already set up; bootstrap needs an empty test instance or admin-credentials.json")
            with open(claimed_path, encoding="utf-8") as handle:
                credentials = json.load(handle)
            admin_email, admin_password = credentials["email"], credentials["password"]
        else:
            admin_email, admin_password = f"ppm-rc-admin-{token(6)}@example.test", password()
        state = {
            "schema": "ppm-smoke-state/1",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bootstrap_url": BASE,
            "golden": "rcsmoke" + token(8),
            "claimed_by_cli": claimed,
            # The instance administrator is the smoke's app user: public sign-up is closed (ENABLE_SIGNUP=0).
            "admin_email": admin_email,
            "admin_password": admin_password,
            "email": admin_email,
            "password": admin_password,
            "issues": [],
            "extends": [],
        }
        remember_sensitive(state["admin_password"])
    else:
        state = load_state()
        if "project_id" in state:
            _fail("bootstrap data already exists for this state file")

    def instance_admin():
        anonymous.csrf()
        response = anonymous.request(
            "POST",
            "/api/instances/admins/sign-up/",
            data={
                "email": state["admin_email"],
                "password": state["admin_password"],
                "first_name": "RC",
                "last_name": "Admin",
                "company_name": "PPM RC rehearsal",
                "is_telemetry_enabled": "False",
            },
            expected=(301, 302, 303),
        )
        if "error_code" in response.headers.get("Location", ""):
            _fail("instance admin sign-up rejected")
        return "test instance admin created (telemetry off)"

    client = Client()

    def public_sign_up_is_closed():
        stranger = Client()
        stranger.csrf()
        response = stranger.request(
            "POST",
            "/auth/sign-up/",
            data={"email": f"stranger-{token(6)}@example.test", "password": password()},
            expected=(301, 302, 303),
        )
        if "error_code" not in response.headers.get("Location", "") or stranger.session.cookies.get("session-id"):
            _fail("a stranger could sign up: public registration is open")
        return "sign-up refused (ENABLE_SIGNUP=0)"

    def workspace_and_project():
        slug = "ppm-rc-" + token(6)
        workspace = client.json("POST", "/api/workspaces/", {"name": "PPM RC smoke", "slug": slug}, expected=(201,))
        state.update(workspace_slug=slug, workspace_id=workspace["id"])
        project = client.json(
            "POST",
            f"/api/workspaces/{slug}/projects/",
            {"name": "RC smoke project", "identifier": "RCS", "network": 0},
            expected=(201,),
        )
        state["project_id"] = project["id"]
        return f"workspace {slug}"

    def work_item_with_attachment():
        name = f"RC smoke Work Item {state['golden']}"
        issue = client.json("POST", f"{api(state)}/issues/", {"name": name, "priority": "none"}, expected=(201,))
        state["issues"].append({"id": issue["id"], "name": name})
        asset = client.json(
            "POST",
            f"/api/assets/v2/workspaces/{state['workspace_slug']}/projects/{state['project_id']}/",
            {
                "name": "rc-smoke.png",
                "type": "image/png",
                "size": len(PNG),
                "entity_type": "ISSUE_ATTACHMENT",
                "entity_identifier": issue["id"],
            },
        )
        upload = asset["upload_data"]
        target = urlparse(upload["url"])
        if (target.hostname, target.port) != (PUBLIC.hostname, PUBLIC.port):
            _fail(f"attachment upload URL points to {target.netloc}, not the public origin")
        stored = requests.post(
            upload["url"],
            data=upload.get("fields", {}),
            files={"file": ("rc-smoke.png", PNG, "image/png")},
            timeout=60,
            verify=CA_BUNDLE or True,
        )
        if stored.status_code not in (200, 201, 204):
            _fail(f"presigned upload returned {stored.status_code}")
        client.request(
            "PATCH",
            f"/api/assets/v2/workspaces/{state['workspace_slug']}/projects/{state['project_id']}/{asset['asset_id']}/",
            json={},
            expected=(204,),
        )
        state["attachment"] = {"asset_id": asset["asset_id"], "sha256": sha256(PNG)}
        return "Work Item + attachment via presigned POST"

    def board_versions():
        boards = client.json("GET", f"{ppm(state)}/canvas/boards/")
        created = client.json(
            "POST",
            f"{ppm(state)}/canvas/boards/",
            {"name": "RC smoke board", "client_operation_id": str(uuid.uuid4())},
            expected=(201,),
        )
        state["board"] = {
            "id": created["board_id"],
            "latest": created["version"],
            "versions": {},
            "default_board_id": boards["default_board_id"],
        }
        save_board(client, state, state["board"], snapshot(f"{state['golden']}-v1", 5))
        save_board(client, state, state["board"], snapshot(f"{state['golden']}-v2", 7))
        return f"board v{state['board']['latest']} saved"

    def vault_versions():
        name = f"rc-smoke-{state['golden']}.txt"
        v1 = f"PPM RC smoke {state['golden']} v1\n".encode()
        v2 = f"PPM RC smoke {state['golden']} v2 (new version)\n".encode()
        entry = upload_vault_file(client, state, name, v1)
        replaced = upload_vault_file(client, state, name, v2, entry_id=entry["id"], base_version=entry["version"])
        state["vault"] = {
            "file": {
                "id": entry["id"],
                "name": name,
                "latest": replaced["version"],
                "versions": {str(entry["version"]): sha256(v1), str(replaced["version"]): sha256(v2)},
            }
        }
        pdf_bytes = make_pdf(f"PPM RC smoke {state['golden']} pdf")
        pdf = client.json_multipart(
            "POST",
            f"{ppm(state)}/vault/files/",
            {"file": ("rc-smoke.pdf", pdf_bytes, "application/pdf")},
            expected=(201,),
        )
        if pdf["kind"] != "pdf":
            _fail(f"PDF stored as {pdf['kind']}")
        state["vault"]["pdf"] = {"id": pdf["id"], "sha256": sha256(pdf_bytes)}
        return "Vault file v1+v2, PDF"

    if phase == "account":
        steps = [] if state["claimed_by_cli"] else [("instance admin sign-up (test only)", instance_admin)]
        steps += [
            ("public sign-up is closed", public_sign_up_is_closed),
            ("sign-in (instance administrator)", lambda: sign_in(client, state["email"], state["password"])),
            ("CSRF cookie is Secure", lambda: Client().csrf_cookie_is_secure()),
        ]
    else:
        steps = [
            (
                "sign-in (instance administrator, now PPM global administrator)",
                lambda: sign_in(client, state["email"], state["password"]),
            ),
            ("workspace + project", workspace_and_project),
            ("Work Item + attachment", work_item_with_attachment),
            ("board create + 2 versions", board_versions),
            ("Vault upload + new version + PDF", vault_versions),
        ]
    for name, func in steps:
        if not report.check(name, func):
            if phase == "account" or "project_id" in state:
                save_state(state)
            report.finish()
    save_state(state)
    if phase == "account":
        report.finish({"next": "grant the PPM global administrator role, then bootstrap-data"})
    report.check(
        "WebSocket presence + canvas.board.changed", lambda: ws_presence(client, state, write_while_connected=True)
    )
    save_state(state)
    report.check(
        "WebSocket refused for a foreign Origin",
        lambda: ws_rejected(state, origin="https://evil.example", cookies=client.cookie_header()),
    )
    report.check("WebSocket refused without a session", lambda: ws_rejected(state, origin=BASE, cookies=None))
    brain_checks(report, client, state)

    def logout_login():
        client.csrf()
        client.request("POST", "/auth/sign-out/", data={}, expected=(301, 302, 303))
        if client.session.cookies.get("session-id"):
            _fail("sign-out kept the session")
        return sign_in(client, state["email"], state["password"])

    report.check("sign-out + sign-in", logout_login)
    verify_database_facts(report, client, state)
    verify_object_facts(report, client, state)
    save_state(state)
    report.finish({"golden": state["golden"], "board_versions": len(state["board"]["versions"])})


def mode_verify(report, *, expect_missing_objects=False):
    state = load_state()
    client = Client()
    if not report.check("sign-in (stored test user)", lambda: sign_in(client, state["email"], state["password"])):
        report.finish()
    verify_database_facts(report, client, state)
    verify_object_facts(report, client, state, expect_failure=expect_missing_objects)
    report.check("WebSocket presence (read-only)", lambda: ws_presence(client, state))
    report.check(
        "WebSocket refused for a foreign Origin",
        lambda: ws_rejected(state, origin="https://evil.example", cookies=client.cookie_header()),
    )
    if not expect_missing_objects:
        brain_checks(report, client, state)
    report.finish(
        {
            "issues": len(state["issues"]),
            "board_latest": state["board"]["latest"],
            "vault_latest": state["vault"]["file"]["latest"],
        }
    )


def mode_extend(report, label):
    state = load_state()
    client = Client()
    if not report.check("sign-in (stored test user)", lambda: sign_in(client, state["email"], state["password"])):
        report.finish()

    def new_work_item():
        name = f"RC smoke {label} {state['golden']}"
        issue = client.json("POST", f"{api(state)}/issues/", {"name": name, "priority": "none"}, expected=(201,))
        state["issues"].append({"id": issue["id"], "name": name})
        return f"Work Item {issue['id'][:8]}"

    def new_board_version():
        saved = save_board(client, state, state["board"], snapshot(f"{label}-{token(4)}", 9))
        return f"board v{saved['version']}"

    def new_vault_version():
        entry = state["vault"]["file"]
        content = f"PPM RC smoke {state['golden']} {label}\n".encode()
        replaced = upload_vault_file(
            client, state, entry["name"], content, entry_id=entry["id"], base_version=entry["latest"]
        )
        entry["versions"][str(replaced["version"])] = sha256(content)
        entry["latest"] = replaced["version"]
        return f"Vault v{replaced['version']}"

    for name, func in (
        ("new Work Item", new_work_item),
        ("new board version", new_board_version),
        ("new Vault version", new_vault_version),
    ):
        report.check(f"extend[{label}]: {name}", func)
        save_state(state)
    state["extends"].append({"label": label, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    save_state(state)
    verify_database_facts(report, client, state)
    verify_object_facts(report, client, state)
    report.finish(
        {"label": label, "board_latest": state["board"]["latest"], "vault_latest": state["vault"]["file"]["latest"]}
    )


def mode_measure(report, rounds=5):
    state = load_state()
    client = Client()
    if not report.check("sign-in (stored test user)", lambda: sign_in(client, state["email"], state["password"])):
        report.finish()
    numbers = {}

    def measure():
        created = client.json(
            "POST",
            f"{ppm(state)}/canvas/boards/",
            {"name": f"RC 300 shapes {token(5)}", "client_operation_id": str(uuid.uuid4())},
            expected=(201,),
        )
        board = {"id": created["board_id"], "latest": created["version"], "versions": {}}
        perf_state = dict(state, board=board)
        saves, loads, events = [], [], []
        size = 0
        with ws_connect(
            ws_uri(perf_state, board["id"]),
            additional_headers={"Cookie": client.cookie_header(), "Origin": BASE},
            ssl=ssl_context(),
            open_timeout=20,
        ) as ws:
            ws_receive(ws, "presence.ready")
            for round_index in range(rounds):
                snap = snapshot(f"perf{round_index}", 300)
                size = len(json.dumps(snap, separators=(",", ":")).encode())
                started = time.monotonic()
                save_board(client, perf_state, board, snap)
                saves.append((time.monotonic() - started) * 1000)
                ws_receive(ws, "canvas.board.changed")
                events.append((time.monotonic() - started) * 1000)
                started = time.monotonic()
                client.json("GET", f"{ppm(perf_state)}/canvas/boards/{board['id']}/")
                loads.append((time.monotonic() - started) * 1000)
        numbers.update(
            shapes=300,
            rounds=rounds,
            snapshot_bytes=size,
            save_ms_median=round(statistics.median(saves)),
            save_ms_max=round(max(saves)),
            load_ms_median=round(statistics.median(loads)),
            load_ms_max=round(max(loads)),
            ws_event_after_save_start_ms_median=round(statistics.median(events)),
        )
        return json.dumps(numbers)

    report.check("300-shape board: save/load/WS (server side)", measure)
    report.finish({"measure": numbers})


def api_error(error):
    """Short, user-facing description of a failed request: status + API error code + message."""
    text = str(error)
    for marker in ('"message":', '"error":'):
        if marker in text:
            return text[:260]
    return text[:200]


def mode_probe():
    state = load_state()
    client = Client()
    client.session.request = _with_timeout(client.session.request, int(os.environ.get("PPM_PROBE_TIMEOUT", "20")))
    results = []

    only = {item.strip() for item in os.environ.get("PPM_PROBE_OPS", "").split(",") if item.strip()}

    def attempt(name, func):
        if only and name != "sign-in" and name not in only:
            return
        started = time.monotonic()
        try:
            detail, outcome = func(), "ok"
        except Exception as error:  # noqa: BLE001 - the probe reports every outcome
            detail, outcome = f"{type(error).__name__}: {api_error(error)}", "error"
        elapsed = round((time.monotonic() - started) * 1000)
        print(f"[probe] {name}: {outcome} ({elapsed} ms) — {detail}", flush=True)
        results.append({"operation": name, "outcome": outcome, "ms": elapsed})

    def save_new_version():
        before = state["board"]["latest"]
        saved = save_board(client, state, state["board"], snapshot(f"probe-{token(4)}", 4))
        save_state(state)
        return f"v{before} -> v{saved['version']}"

    def upload_probe_file():
        name = f"probe-{token(6)}.txt"
        entry = upload_vault_file(client, state, name, f"probe {state['golden']}\n".encode())
        return f"Vault entry {entry['id'][:8]} v{entry['version']}"

    def create_work_item():
        issue = client.json(
            "POST", f"{api(state)}/issues/", {"name": f"probe {token(5)}", "priority": "none"}, expected=(201,)
        )
        return f"Work Item {issue['id'][:8]}"

    attempt("sign-in", lambda: sign_in(client, state["email"], state["password"]))
    if os.environ.get("PPM_PROBE_WAIT_FOR_GO") == "1":
        # Sign in while everything is healthy, then let the operator break a dependency (touch /state/probe-go).
        ready, go = (
            os.path.join(os.path.dirname(STATE_PATH), "probe-ready"),
            os.path.join(os.path.dirname(STATE_PATH), "probe-go"),
        )
        open(ready, "w").close()
        deadline = time.monotonic() + 300
        while not os.path.exists(go) and time.monotonic() < deadline:
            time.sleep(1)
        for path in (ready, go):
            if os.path.exists(path):
                os.remove(path)
        print("[probe] dependency broken by the operator; probing with the existing session", flush=True)
    attempt("read board", lambda: _check_board_current(client, state))
    attempt("save board (new version)", save_new_version)
    attempt("create Work Item", create_work_item)
    attempt("Vault upload", upload_probe_file)
    attempt(
        "Vault download (presigned)",
        lambda: _check_vault_download(
            client,
            state,
            str(state["vault"]["file"]["latest"]),
            state["vault"]["file"]["versions"][str(state["vault"]["file"]["latest"])],
        ),
    )
    attempt("WebSocket presence", lambda: ws_presence(client, state))
    attempt("Brain search", lambda: brain_golden_search(client, state))
    print("PROBE_RESULT " + json.dumps(results, ensure_ascii=False), flush=True)


def mode_log_probe(report):
    state = load_state()
    client = Client()
    client.csrf()
    planted = {
        name: f"ppmlogprobe{token(20)}"
        for name in (
            "uid",
            "reset",
            "invite",
            "invite_email",
            "space",
            "admin",
            "live",
            "live_cookie",
            "oauth_code",
            "oauth_state",
            "api_reset",
            "api_query",
            "referer",
        )
    }
    remember_sensitive(*planted.values())
    referer = f"{BASE}/accounts/reset-password?uidb64={planted['uid']}&token={planted['referer']}"
    everything = tuple(range(100, 600))

    def hit(method, path):
        response = client.request(method, path, expected=everything, headers={"Referer": referer})
        return f"HTTP {response.status_code}"

    def live_websocket():
        try:
            with ws_connect(
                f"{BASE.replace('https://', 'wss://')}/live/collaboration?documentId={uuid.uuid4()}"
                f"&token={planted['live']}",
                ssl=ssl_context(),
                additional_headers={"Cookie": f"session-id={planted['live_cookie']}", "Origin": BASE},
                open_timeout=15,
            ) as socket:
                socket.close()
            return "handshake accepted"
        except InvalidStatus as error:
            return f"handshake refused with HTTP {error.response.status_code}"
        except OSError as error:
            return f"connection ended ({type(error).__name__})"

    probes = [
        (
            "web: password-reset page",
            "GET",
            f"/accounts/reset-password?uidb64={planted['uid']}&token={planted['reset']}",
        ),
        (
            "web: invitation page",
            "GET",
            f"/workspace-invitations/?invitation_id={uuid.uuid4()}&email={planted['invite_email']}%40example.test"
            f"&slug={state['workspace_slug']}&token={planted['invite']}",
        ),
        (
            "space: password-reset page",
            "GET",
            f"/spaces/accounts/reset-password?uidb64={planted['uid']}&token={planted['space']}",
        ),
        ("admin: god-mode with a token", "GET", f"/god-mode/?token={planted['admin']}"),
        ("live: HTTP with a token", "GET", f"/live/health?token={planted['live']}"),
        (
            "api: OAuth callback",
            "GET",
            f"/auth/github/callback/?code={planted['oauth_code']}&state={planted['oauth_state']}",
        ),
        ("api: password-reset link", "POST", f"/auth/reset-password/{planted['uid']}/{planted['api_reset']}/"),
        ("api: token in a query", "GET", f"/api/workspaces/{state['workspace_slug']}/?token={planted['api_query']}"),
    ]
    for label, method, path in probes:
        report.check(label, lambda method=method, path=path: hit(method, path))
    report.check("live: WebSocket with a token and a session cookie", live_websocket)
    report.finish({"planted_values": len(planted)})


def _with_timeout(request, seconds):
    def wrapped(method, url, **kwargs):
        kwargs["timeout"] = seconds
        return request(method, url, **kwargs)

    return wrapped


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    mode = sys.argv[1]
    report = Report(mode)
    if mode in ("bootstrap-account", "bootstrap-data"):
        mode_bootstrap(report, mode.split("-", 1)[1])
    elif mode == "verify":
        mode_verify(report)
    elif mode == "expect-missing-objects":
        mode_verify(report, expect_missing_objects=True)
    elif mode == "extend":
        mode_extend(report, sys.argv[2] if len(sys.argv) > 2 else "extend")
    elif mode == "measure-300":
        mode_measure(report)
    elif mode == "probe":
        mode_probe()
    elif mode == "log-probe":
        mode_log_probe(report)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
