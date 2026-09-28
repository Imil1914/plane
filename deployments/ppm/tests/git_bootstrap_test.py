#!/usr/bin/env python3
"""Checks of forgejo/git_bootstrap.py against a fake Forgejo API on 127.0.0.1 (no network, no containers).

The fake keeps the parts of Forgejo 15 the tool relies on (routers/api/v1/api.go, permissions/*):
- creating and deleting tokens needs PASSWORD authentication (req_basic_or_rev_proxy_auth.go) — a token, even sent
  as the basic-auth password, is refused;
- tokens carry scopes: /user needs read:user, /admin/* needs read:admin / write:admin, writes need write:*;
- PATCH /admin/users/{name} sets a password (and must_change_password) with an administrator's token;
- POST /admin/hooks makes a *system* webhook only with config.is_system_webhook=true ("default" otherwise, not
  listed by GET /admin/hooks); the API name "pull_request" switches on every pull request sub-event.
Each scenario runs the real tool as a subprocess (stdin/stdout/stderr/exit code) and checks that no secret ever
reaches its command line or output. Prints `  ok    …` / `  FAIL  …` lines and a final
`git-bootstrap-test: <passed> passed, <failed> failed`; exit 1 on any failure.
"""

import base64
import json
import os
import secrets
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# PPM_GIT_BOOTSTRAP_TOOL: run the checks against another copy of the tool (mutation checks of this test).
TOOL = os.environ.get("PPM_GIT_BOOTSTRAP_TOOL") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "forgejo", "git_bootstrap.py")
HOOK_URL = "http://api:8000/api/ppm/v1/git/forgejo/webhook/"
READ_SCOPES = ["read:organization", "read:repository", "read:user"]
BOOT_SCOPES = ["read:user", "write:admin"]
PULL_REQUEST_ALL = ["pull_request", "pull_request_assign", "pull_request_label", "pull_request_milestone",
                    "pull_request_comment", "pull_request_review_approved", "pull_request_review_rejected",
                    "pull_request_review_comment", "pull_request_review_request", "pull_request_sync"]
EVENT_FLAGS = {
    "push": ["push"], "pull_request_only": ["pull_request"], "pull_request": PULL_REQUEST_ALL,
    "pull_request_sync": ["pull_request_sync"], "create": ["create"], "delete": ["delete"], "repository": ["repository"],
}


def has_scope(scopes, wanted):
    """Forgejo semantics: all ⊇ everything; write:x ⊇ read:x."""
    if "all" in scopes or wanted in scopes:
        return True
    kind, _, category = wanted.partition(":")
    return kind == "read" and f"write:{category}" in scopes


class State:
    def __init__(self):
        self.users = {"ppm-bot": {"password": "initial-bot-password-0", "admin": True, "must_change": False},
                      "owner": {"password": "initial-owner-password-0", "admin": True, "must_change": False}}
        self.tokens = []  # {id, uid, name, value, scopes}
        self.hooks = []  # {id, url, type, content_type, secret, events, active, system}
        self.next_id = 100
        self.requests = []  # (method, path)
        self.passwords_used = set()  # every password sent in a basic-auth header
        self.password_history = []  # every password set on ppm-bot

    def new_id(self):
        self.next_id += 1
        return self.next_id

    def add_token(self, name, scopes, user="ppm-bot"):
        token = {"id": self.new_id(), "user": user, "name": name, "value": secrets.token_hex(20), "scopes": list(scopes)}
        self.tokens.append(token)
        return token

    def bot_tokens(self):
        return [t for t in self.tokens if t["user"] == "ppm-bot"]


STATE = State()


class FakeForgejo(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def reply(self, status, body=None):
        raw = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def auth(self):
        """(kind, user, token): kind is "password", "token" or None."""
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            user, _, password = base64.b64decode(header[6:]).decode().partition(":")
            STATE.passwords_used.add(password)
            if user in STATE.users and password == STATE.users[user]["password"]:
                return "password", user, None
            for token in STATE.tokens:  # a token as the basic-auth password is token authentication
                if token["value"] == password and token["user"] == user:
                    return "token", user, token
            return None, None, None
        if header.startswith("token "):
            for token in STATE.tokens:
                if token["value"] == header[6:]:
                    return "token", token["user"], token
        return None, None, None

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def handle_any(self, method):
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)
        STATE.requests.append((method, path))
        kind, user, token = self.auth()
        if kind is None:
            # Like Forgejo 15: the presented token is echoed in the message ("access token does not exist [sha: …]").
            presented = self.headers.get("Authorization", "").split(" ", 1)[-1]
            return self.reply(401, {"message": f"access token does not exist [sha: {presented}]"})

        def scope(wanted):
            return kind == "password" or has_scope(token["scopes"], wanted)

        page = int((query.get("page") or ["1"])[0]); limit = int((query.get("limit") or ["50"])[0])
        window = slice((page - 1) * limit, page * limit)
        if method == "GET" and path == "/api/v1/user":
            if not scope("read:user"):
                return self.reply(403, {"message": "token does not have at least one of required scope(s)"})
            return self.reply(200, {"login": user, "is_admin": STATE.users[user]["admin"], "active": True})
        if path == "/api/v1/users/ppm-bot/tokens":
            if method == "GET":
                if not scope("read:user"):
                    return self.reply(403, {"message": "missing scope"})
                return self.reply(200, [
                    {"id": t["id"], "name": t["name"], "sha1": "", "token_last_eight": t["value"][-8:], "scopes": t["scopes"]}
                    for t in STATE.bot_tokens()][window])
            if method == "POST":
                if kind != "password":
                    return self.reply(401, {"message": "auth method not allowed"})
                data = self.body()
                if any(t["name"] == data["name"] for t in STATE.bot_tokens()):
                    return self.reply(400, {"message": "access token name has been used already"})
                created = STATE.add_token(data["name"], data.get("scopes") or [])
                return self.reply(201, {"id": created["id"], "name": created["name"], "sha1": created["value"],
                                        "token_last_eight": created["value"][-8:], "scopes": created["scopes"]})
        if method == "DELETE" and path.startswith("/api/v1/users/ppm-bot/tokens/"):
            if kind != "password":
                return self.reply(401, {"message": "auth method not allowed"})
            before = len(STATE.tokens)
            STATE.tokens = [t for t in STATE.tokens if str(t["id"]) != path.rsplit("/", 1)[1]]
            return self.reply(204 if len(STATE.tokens) < before else 404)
        if method == "POST" and path == "/api/v1/user/repos":
            if not scope("write:repository"):
                return self.reply(403, {"message": "token does not have at least one of required scope(s)"})
            return self.reply(422, {"message": "[Name]: Required"})
        if path.startswith("/api/v1/admin/"):
            if not STATE.users[user]["admin"]:
                return self.reply(403, {"message": "must be an admin"})
            if not scope("write:admin" if method != "GET" else "read:admin"):
                return self.reply(403, {"message": "token does not have at least one of required scope(s)"})
        if method == "PATCH" and path.startswith("/api/v1/admin/users/"):
            name = path.rsplit("/", 1)[1]
            if name not in STATE.users:
                return self.reply(404, {"message": "user does not exist"})
            data = self.body()
            if data.get("password"):
                STATE.users[name]["password"] = data["password"]
                if name == "ppm-bot":
                    STATE.password_history.append(data["password"])
            if "must_change_password" in data:
                STATE.users[name]["must_change"] = bool(data["must_change_password"])
            return self.reply(200, {"login": name})
        if path == "/api/v1/admin/hooks" or path.startswith("/api/v1/admin/hooks/"):
            if method == "GET":
                return self.reply(200, [
                    {"id": h["id"], "type": h["type"], "url": h["url"], "content_type": h["content_type"],
                     "config": {"url": h["url"], "content_type": h["content_type"]}, "events": h["events"],
                     "active": h["active"]}
                    for h in STATE.hooks if h["system"]][window])
            if method == "POST":
                data = self.body()
                events = sorted({flag for name in data.get("events") or ["push"] for flag in EVENT_FLAGS.get(name, [])})
                hook = {"id": STATE.new_id(), "url": data["config"]["url"], "type": data["type"],
                        "content_type": data["config"]["content_type"], "secret": data["config"].get("secret", ""),
                        "events": events, "active": bool(data.get("active")),
                        "system": data["config"].get("is_system_webhook") == "true"}
                STATE.hooks.append(hook)
                return self.reply(201, {"id": hook["id"], "type": hook["type"], "url": hook["url"],
                                        "events": hook["events"], "active": hook["active"]})
            if method == "DELETE":
                before = len(STATE.hooks)
                STATE.hooks = [h for h in STATE.hooks if str(h["id"]) != path.rsplit("/", 1)[1]]
                return self.reply(204 if len(STATE.hooks) < before else 404)
        return self.reply(404, {"message": "not found"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PATCH(self):
        self.handle_any("PATCH")

    def do_DELETE(self):
        self.handle_any("DELETE")


passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok    {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}{' — ' + detail if detail else ''}")


class Run:
    def __init__(self, done, argv, stdin):
        self.done, self.argv, self.stdin = done, argv, stdin
        self.rc, self.stdout, self.stderr = done.returncode, done.stdout, done.stderr

    def value(self, key):
        for line in self.stdout.splitlines():
            if line.startswith(key + "="):
                return line[len(key) + 1:]
        return ""


def run_tool(base, stdin_lines, *args):
    env = dict(os.environ, PPM_FORGEJO_URL=base, PPM_FORGEJO_HOOK_URL=HOOK_URL)
    argv = [sys.executable, TOOL, *args]
    stdin = "".join(f"{line}\n" for line in stdin_lines)
    done = subprocess.run(argv, input=stdin, capture_output=True, text=True, env=env, timeout=60)
    return Run(done, argv, stdin)


def secrets_seen():
    """Every secret the fake knows: all token values and every password ppm-bot or owner ever had or got."""
    values = {t["value"] for t in STATE.tokens} | set(STATE.password_history) | STATE.passwords_used
    values |= {u["password"] for u in STATE.users.values()}
    return {v for v in values if v and len(v) >= 8}


ALL_SECRETS = set()  # grows: tokens and passwords can disappear from the fake's state


def leaks(run, allowed_stdout=()):
    """Secrets on the tool's command line, stderr, or stdout (except the key=value lines that are its result)."""
    ALL_SECRETS.update(secrets_seen())
    stdout = run.stdout
    for key in allowed_stdout:
        value = run.value(key)
        stdout = stdout.replace(f"{key}={value}\n", "")
    found = []
    for value in ALL_SECRETS:
        if any(value in arg for arg in run.argv) or value in run.stderr or value in stdout:
            found.append(value[:4] + "…")
    return found


def boot_token():
    """What `forgejo admin user generate-access-token --scopes write:admin,read:user` gives ppm-deploy.sh."""
    return STATE.add_token(f"ppm-bootstrap-{secrets.token_hex(4)}", BOOT_SCOPES)


def token_alive(value):
    return any(t["value"] == value for t in STATE.tokens)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeForgejo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    secret = secrets.token_hex(32)
    stray = STATE.add_token("left-by-hand", ["all"])
    STATE.hooks.append({"id": STATE.new_id(), "url": HOOK_URL, "type": "gitea", "content_type": "form", "secret": "old",
                        "events": ["push"], "active": False, "system": True})
    initial_bot_password = STATE.users["ppm-bot"]["password"]

    # --- prepare, first run
    boot = boot_token()
    run = run_tool(base, [boot["value"], "", secret], "prepare")
    first = run.value("token")
    check("prepare (first run) creates a new read-only token and prints it as token=… only",
          run.rc == 0 and len(first) == 40, run.stderr.strip()[-200:])
    new = [t for t in STATE.bot_tokens() if t["value"] == first]
    check("  ... the token is named ppm-read-<UTC> and has exactly the three read scopes",
          len(new) == 1 and new[0]["name"].startswith("ppm-read-") and sorted(new[0]["scopes"]) == READ_SCOPES,
          str([(t["name"], t["scopes"]) for t in new]))
    check("  ... nothing is revoked by prepare (the stray token and the temporary one still exist)",
          token_alive(stray["value"]) and token_alive(boot["value"]))
    check("  ... the password of ppm-bot was replaced and ends as a value never used or shown",
          STATE.users["ppm-bot"]["password"] != initial_bot_password
          and STATE.users["ppm-bot"]["password"] not in STATE.passwords_used
          and STATE.users["ppm-bot"]["password"] not in run.stdout + run.stderr)
    check("  ... token creation used password authentication (tokens are refused there)",
          ("POST", "/api/v1/users/ppm-bot/tokens") in STATE.requests and len(STATE.password_history) >= 2)
    system = [h for h in STATE.hooks if h["system"]]
    check("  ... one system webhook (is_system_webhook) replaces the old one: forgejo, JSON, active, the secret",
          len(system) == 1 and system[0]["type"] == "forgejo" and system[0]["content_type"] == "json"
          and system[0]["active"] and system[0]["secret"] == secret and system[0]["url"] == HOOK_URL, str(system))
    check("  ... events push, pull_request (+sync), create, delete, repository — no comments/reviews",
          system and set(system[0]["events"]) == {"push", "pull_request", "pull_request_sync", "create", "delete",
                                                  "repository"}, str(system and system[0]["events"]))
    check("  ... the read-only check tried a write with the new token and was refused (403)",
          ("POST", "/api/v1/user/repos") in STATE.requests)
    check("  ... no secret on its command line, stderr or stdout (the new token only as token=)",
          not leaks(run, ("token",)), str(leaks(run, ("token",))))

    # --- finish: revoke everything else, including the temporary token
    run = run_tool(base, [boot["value"], first], "finish")
    check("finish keeps only the token now in use: stray token and temporary token revoked",
          run.rc == 0 and [t["value"] for t in STATE.bot_tokens()] == [first], run.stderr.strip()[-200:])
    check("  ... prints nothing on stdout and no secret anywhere", run.stdout == "" and not leaks(run), str(leaks(run)))
    check("  ... ppm-bot ends with a password nobody used or saw",
          STATE.users["ppm-bot"]["password"] not in STATE.passwords_used)

    # --- a second full run: keep
    boot = boot_token()
    run = run_tool(base, [boot["value"], first, secret], "prepare")
    hook_ids = [h["id"] for h in STATE.hooks if h["system"]]
    check("prepare with a working current token keeps it (stdout empty, no token created)",
          run.rc == 0 and run.stdout == "" and len([t for t in STATE.bot_tokens() if t["name"].startswith("ppm-read")]) == 1,
          run.stderr.strip()[-200:])
    check("  ... the webhook is recreated (Forgejo sets a secret only on creation), still exactly one",
          len(hook_ids) == 1 and hook_ids != [h["id"] for h in system])
    run = run_tool(base, [boot["value"], first], "finish")
    check("  ... finish revokes the temporary token of this run", run.rc == 0 and not token_alive(boot["value"]))

    # --- rotation: the old token stays valid until finish
    boot = boot_token()
    run = run_tool(base, [boot["value"], first, secret], "prepare", "--rotate-token")
    rotated = run.value("token")
    check("prepare --rotate-token issues a new token and does NOT revoke the old one yet",
          run.rc == 0 and rotated and rotated != first and token_alive(first) and token_alive(rotated),
          run.stderr.strip()[-200:])
    run = run_tool(base, [boot["value"], rotated], "finish")
    check("  ... finish with the new token revokes the old one", run.rc == 0 and not token_alive(first) and token_alive(rotated))

    # --- finish refuses to revoke when the token in use is broken
    boot = boot_token()
    run = run_tool(base, [boot["value"], "0" * 40], "finish")
    check("finish with a token Forgejo does not know revokes nothing (exit 1)",
          run.rc == 1 and token_alive(rotated) and token_alive(boot["value"]) and "nothing" in run.stderr.lower(),
          run.stderr.strip()[-200:])
    writer = STATE.add_token("ppm-read-writer", READ_SCOPES + ["write:repository"])
    run = run_tool(base, [boot["value"], writer["value"]], "finish")
    check("finish with a token that can write revokes nothing (exit 1)",
          run.rc == 1 and token_alive(rotated) and token_alive(writer["value"]))

    # --- cleanup after a failure: only temporary tokens go
    run = run_tool(base, [boot["value"]], "cleanup")
    check("cleanup revokes only the temporary tokens (ppm-bootstrap-*); PPM's token stays",
          run.rc == 0 and not token_alive(boot["value"]) and token_alive(rotated) and token_alive(writer["value"]),
          run.stderr.strip()[-200:])
    check("  ... no secret anywhere", not leaks(run), str(leaks(run)))

    # --- one-time password for the owner
    boot = boot_token()
    before = STATE.users["owner"]["password"]
    run = run_tool(base, [boot["value"]], "reset-password", "owner")
    one_time = run.value("password")
    check("reset-password gives the owner a new one-time password (printed as password=… only)",
          run.rc == 0 and len(one_time) >= 16 and STATE.users["owner"]["password"] == one_time != before
          and STATE.users["owner"]["must_change"], run.stderr.strip()[-200:])
    check("  ... and revokes the temporary token", not token_alive(boot["value"]))
    check("  ... no secret on its command line or stderr", not leaks(run, ("password",)), str(leaks(run, ("password",))))
    boot = boot_token()
    run = run_tool(base, [boot["value"]], "reset-password", "PPM-Bot")
    check("reset-password refuses the service account", run.rc == 1 and "service account" in run.stderr)

    # --- refusals
    STATE.users["ppm-bot"]["admin"] = False
    run = run_tool(base, [boot["value"], rotated, secret], "prepare")
    check("ppm-bot that lost the administrator flag is refused with the reason",
          run.rc == 1 and "not a Forgejo administrator" in run.stderr)
    STATE.users["ppm-bot"]["admin"] = True
    bogus = secrets.token_hex(20)
    run = run_tool(base, [bogus, rotated, secret], "prepare")
    check("an invalid temporary token fails (exit 1, HTTP 401)", run.rc == 1 and "HTTP 401" in run.stderr)
    check("  ... and the token Forgejo echoes in its 401 message is not printed", bogus not in run.stderr + run.stdout)
    run = run_tool(base, [bogus], "cleanup")
    check("cleanup with a revoked temporary token prints no token either", bogus not in run.stderr + run.stdout)
    run = run_tool(base, [boot["value"], rotated, "short"], "prepare")
    check("a missing/short webhook secret is refused before any call",
          run.rc == 1 and "PPM_FORGEJO_WEBHOOK_SECRET" in run.stderr)
    run = run_tool(base, [boot["value"]], "frobnicate")
    check("an unknown subcommand is refused", run.rc == 1 and "unknown" in run.stderr)

    server.shutdown()
    run = run_tool(base, [boot["value"], rotated, secret], "prepare")
    check("Forgejo not reachable: exit 1 with a short reason", run.rc == 1 and "not reachable" in run.stderr)

    print(f"git-bootstrap-test: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
