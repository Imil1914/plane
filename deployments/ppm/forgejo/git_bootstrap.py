#!/usr/bin/env python3
"""Forgejo API part of `ppm-deploy.sh git-bootstrap` and `git-admin --reset-password` (PPM API image, Compose network).

No secret ever appears on a command line: every secret arrives on stdin, and a secret this tool produces leaves only
as one `key=value` line on stdout. Progress and errors go to stderr and never contain a secret.

Credential: a temporary token of ppm-bot (`ppm-bootstrap-…`, scopes write:admin and read:user) that ppm-deploy.sh
gets from `forgejo admin user generate-access-token` inside the Forgejo container — the only way to authenticate
without a password on a command line. Forgejo creates and revokes tokens only for PASSWORD authentication
(routers/api/v1/permissions/req_basic_or_rev_proxy_auth.go), so when tokens must be created or revoked, the tool
sets ppm-bot a random password that exists only in this process (PATCH /admin/users with the temporary token), uses
it, and before it exits replaces it with another random password that is never used or shown.

Subcommands (stdin lines in brackets):
  prepare [--rotate-token]   [temporary token, current PPM_FORGEJO_TOKEN, PPM_FORGEJO_WEBHOOK_SECRET]
      ppm-bot must be an active administrator; recreates the system webhook to the PPM receiver; keeps the current
      read-only token while it works and has exactly the read scopes, else (or with --rotate-token) creates a NEW
      token `ppm-read-<UTC>` and prints `token=<value>`. Revokes nothing: ppm-deploy.sh first saves the new token and
      restarts the API.
  finish                     [temporary token, the PPM_FORGEJO_TOKEN now in use]
      checks that this token works, can only read and has exactly the read scopes, then revokes every other token of
      ppm-bot (previous PPM tokens, leftovers of interrupted runs, the temporary token).
  cleanup                    [temporary token]
      after a failure: revokes the temporary tokens (ppm-bootstrap-*) and nothing else.
  reset-password <user>      [temporary token]
      gives <user> a random one-time password (Forgejo asks for a new one at the next sign-in), prints
      `password=<value>`, then revokes the temporary token.
Exit 1 with a short reason on any failure.
"""

import base64
import datetime
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request

BOT = "ppm-bot"
TOKEN_PREFIX = "ppm-read"
BOOT_PREFIX = "ppm-bootstrap-"
TOKEN_SCOPES = ["read:organization", "read:repository", "read:user"]
# API names: "pull_request_only" is the pull request itself (opened, closed, reopened, edited, merged) — the bare
# "pull_request" would also subscribe comments, reviews, labels, assignees; "pull_request_sync" adds new commits.
HOOK_EVENTS = ["push", "pull_request_only", "pull_request_sync", "create", "delete", "repository"]
# What Forgejo must report back for them (X-Forgejo-Event of the deliveries: push, pull_request, create, delete,
# repository); a later Forgejo may report more, never less.
HOOK_EVENTS_REQUIRED = {"push", "pull_request", "pull_request_sync", "create", "delete", "repository"}
TIMEOUT = 20


class BootstrapError(Exception):
    pass


def say(message):
    print(f"git-bootstrap: {message}", file=sys.stderr)


def random_password(length=40):
    return secrets.token_urlsafe(48)[:length]


class Forgejo:
    def __init__(self, base_url, token):
        self.base = base_url.rstrip("/") + "/api/v1"
        self.token = token
        self.password = None  # set only while tokens are created or revoked

    def call(self, method, path, body=None, auth="token", token=None, expect=(200,)):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Accept", "application/json")
        if token is not None:
            request.add_header("Authorization", f"token {token}")
        elif auth == "password":
            credentials = base64.b64encode(f"{BOT}:{self.password}".encode()).decode()
            request.add_header("Authorization", f"Basic {credentials}")
        else:
            request.add_header("Authorization", f"token {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        except (urllib.error.URLError, OSError) as error:
            raise BootstrapError(f"Forgejo is not reachable at {self.base} ({error.__class__.__name__})") from None
        if status not in expect:
            # Only Forgejo's own short message: bodies of requests (secrets) are never echoed, and Forgejo 15 puts the
            # presented token into its 401 text ("access token does not exist [sha: <token>]") — long hex runs go.
            message = ""
            try:
                message = str(json.loads(raw or b"{}").get("message", ""))
            except (ValueError, AttributeError):
                pass
            message = re.sub(r"[0-9A-Fa-f]{16,}", "<hidden>", message)[:200]
            raise BootstrapError(f"{method} {path.split('?')[0]}: HTTP {status} {message}".rstrip())
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            raise BootstrapError(f"{method} {path.split('?')[0]}: the answer is not JSON") from None

    def paged(self, path):
        items, page = [], 1
        while True:
            separator = "&" if "?" in path else "?"
            batch = self.call("GET", f"{path}{separator}page={page}&limit=50") or []
            items.extend(batch)
            if len(batch) < 50:
                return items
            page += 1

    def set_bot_password(self, auth):
        """A new random password for ppm-bot, known only to this process (source/login name are not touched)."""
        value = random_password()
        self.call("PATCH", f"/admin/users/{BOT}", {"password": value, "must_change_password": False}, auth=auth)
        self.password = value

    def forget_bot_password(self):
        """Replaces the in-process password with one nobody ever sees; a failure leaves an equally unknown one."""
        if self.password is None:
            return
        try:
            self.call("PATCH", f"/admin/users/{BOT}",
                      {"password": random_password(), "must_change_password": False}, auth="password")
        except BootstrapError as error:
            say(f"WARNING: could not replace the temporary password of {BOT} ({error}); it was random and is gone "
                "with this process")
        self.password = None


def check_admin(forgejo):
    me = forgejo.call("GET", "/user")
    if not isinstance(me, dict) or me.get("login") != BOT:
        raise BootstrapError("the temporary token does not belong to ppm-bot")
    if not me.get("is_admin"):
        raise BootstrapError(
            "ppm-bot is not a Forgejo administrator any more (it must see every repository): make it one again in "
            "Site administration → User accounts"
        )
    say(f"{BOT} is an active administrator")


def token_works(forgejo, token):
    """True when the token authenticates as ppm-bot (read:user is enough for /user)."""
    try:
        me = forgejo.call("GET", "/user", token=token)
    except BootstrapError:
        return False
    return isinstance(me, dict) and me.get("login") == BOT


def token_entry(tokens, value):
    """The listed token of PPM that the value belongs to: our name, the same last eight characters, exact scopes."""
    for entry in tokens:
        if (
            entry.get("name", "").startswith(TOKEN_PREFIX)
            and value
            and entry.get("token_last_eight") == value[-8:]
            and sorted(entry.get("scopes") or []) == sorted(TOKEN_SCOPES)
        ):
            return entry
    return None


def read_only(forgejo, token):
    """A write with the token must be refused by the scope check (the empty body could not create anything)."""
    try:
        forgejo.call("POST", "/user/repos", {}, token=token, expect=(403,))
    except BootstrapError:
        return False
    return True


def ensure_webhook(forgejo, hook_url, secret):
    removed = 0
    for hook in forgejo.paged("/admin/hooks"):
        if hook.get("url") == hook_url or (hook.get("config") or {}).get("url") == hook_url:
            forgejo.call("DELETE", f"/admin/hooks/{hook['id']}", expect=(204,))
            removed += 1
    created = forgejo.call(
        "POST",
        "/admin/hooks",
        {
            "type": "forgejo",
            # is_system_webhook: without it POST /admin/hooks makes a "default" webhook (copied into NEW
            # repositories only) instead of one for every repository.
            "config": {"url": hook_url, "content_type": "json", "secret": secret, "is_system_webhook": "true"},
            "events": HOOK_EVENTS,
            "branch_filter": "*",
            "active": True,
        },
        expect=(201,),
    )
    ours = [
        hook for hook in forgejo.paged("/admin/hooks")
        if hook.get("url") == hook_url or (hook.get("config") or {}).get("url") == hook_url
    ]
    if len(ours) != 1 or ours[0].get("id") != (created or {}).get("id"):
        raise BootstrapError(f"expected exactly one system webhook to {hook_url}, found {len(ours)}")
    hook = ours[0]
    if hook.get("type") != "forgejo" or not hook.get("active") or hook.get("content_type") != "json":
        raise BootstrapError("the system webhook was not stored as an active JSON webhook of type forgejo")
    missing = HOOK_EVENTS_REQUIRED - set(hook.get("events") or [])
    if missing:
        raise BootstrapError(f"the system webhook lacks the events {sorted(missing)}")
    say(f"system webhook {hook['id']} → {hook_url} (forgejo, JSON, signed; events: "
        f"{', '.join(sorted(set(hook.get('events') or [])))}); {removed} previous one(s) replaced")


def prepare(forgejo, current, secret, rotate, hook_url):
    if len(secret) < 20:
        raise BootstrapError("PPM_FORGEJO_WEBHOOK_SECRET is missing or shorter than 20 characters")
    check_admin(forgejo)
    ensure_webhook(forgejo, hook_url, secret)
    tokens = forgejo.paged(f"/users/{BOT}/tokens")
    if not rotate and token_entry(tokens, current) and token_works(forgejo, current):
        say(f"read-only token of PPM kept (still valid, exact scopes)")
        return None
    names = {entry.get("name") for entry in tokens}
    name = f"{TOKEN_PREFIX}-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    while name in names:
        name = f"{name}-{secrets.token_hex(2)}"
    forgejo.set_bot_password("token")
    try:
        created = forgejo.call("POST", f"/users/{BOT}/tokens", {"name": name, "scopes": TOKEN_SCOPES},
                               auth="password", expect=(201,))
        value = (created or {}).get("sha1") or ""
        problem = None
        if not value:
            problem = "Forgejo created the token but returned no value"
        elif sorted(created.get("scopes") or []) != sorted(TOKEN_SCOPES):
            problem = "the new token does not carry exactly the read-only scopes"
        elif not token_works(forgejo, value):
            problem = "the new token does not authenticate as ppm-bot"
        elif not read_only(forgejo, value):
            problem = "the new token is not read-only (a write was not refused)"
        if problem:
            if created and created.get("id"):
                forgejo.call("DELETE", f"/users/{BOT}/tokens/{created['id']}", auth="password", expect=(204, 404))
            raise BootstrapError(f"{problem}; it was revoked again")
    finally:
        forgejo.forget_bot_password()
    reason = "--rotate-token" if rotate else ("the current one is missing, invalid or has other scopes" if current else "first run")
    say(f"new read-only token {name} issued ({reason}); nothing revoked yet")
    return value


def finish(forgejo, current):
    check_admin(forgejo)
    tokens = forgejo.paged(f"/users/{BOT}/tokens")
    ours = token_entry(tokens, current)
    if not ours or not token_works(forgejo, current):
        raise BootstrapError("PPM_FORGEJO_TOKEN is not a working read-only token of ppm-bot; nothing was revoked")
    if not read_only(forgejo, current):
        raise BootstrapError("PPM_FORGEJO_TOKEN can write; nothing was revoked")
    others = [entry for entry in tokens if entry.get("id") != ours.get("id")]
    # The temporary token (this run's credential) goes last.
    others.sort(key=lambda entry: entry.get("name", "").startswith(BOOT_PREFIX))
    forgejo.set_bot_password("token")
    try:
        for entry in others:
            forgejo.call("DELETE", f"/users/{BOT}/tokens/{entry['id']}", auth="password", expect=(204, 404))
    finally:
        forgejo.forget_bot_password()
    stale = sum(1 for entry in others if not entry.get("name", "").startswith(BOOT_PREFIX))
    say(f"PPM's read-only token {ours.get('name')} is the only token of {BOT}: {stale} previous token(s) and "
        f"{len(others) - stale} temporary token(s) revoked; its password is random and unknown")


def cleanup(forgejo):
    try:
        tokens = forgejo.paged(f"/users/{BOT}/tokens")
    except BootstrapError as error:
        say(f"nothing to clean up with this temporary token ({error})")
        return
    temporary = [entry for entry in tokens if entry.get("name", "").startswith(BOOT_PREFIX)]
    forgejo.set_bot_password("token")
    try:
        for entry in temporary:
            forgejo.call("DELETE", f"/users/{BOT}/tokens/{entry['id']}", auth="password", expect=(204, 404))
    finally:
        forgejo.forget_bot_password()
    say(f"{len(temporary)} temporary token(s) of {BOT} revoked")


def reset_password(forgejo, user):
    if user.lower() == BOT:
        raise BootstrapError(f"{BOT} is the PPM service account; its password is never handed out")
    check_admin(forgejo)
    value = random_password(20)
    # Only password and must_change_password: the login source (e.g. sign-in through PPM later) stays as it is.
    forgejo.call("PATCH", f"/admin/users/{user}", {"password": value, "must_change_password": True})
    sys.stdout.write(f"password={value}\n")
    sys.stdout.flush()
    say(f"one-time password set for {user} (a new one is required at the next sign-in)")
    cleanup(forgejo)


def main(argv):
    if not argv or argv[0] not in ("prepare", "finish", "cleanup", "reset-password"):
        raise BootstrapError(f"unknown subcommand {argv[0] if argv else '(none)'} (prepare, finish, cleanup, reset-password)")
    command, args = argv[0], argv[1:]
    rotate = False
    user = None
    if command == "prepare":
        for arg in args:
            if arg != "--rotate-token":
                raise BootstrapError(f"unknown argument {arg}")
            rotate = True
    elif command == "reset-password":
        if len(args) != 1:
            raise BootstrapError("reset-password needs exactly one user name")
        user = args[0]
    elif args:
        raise BootstrapError(f"{command} takes no arguments")
    lines = sys.stdin.read().split("\n") + ["", "", ""]
    boot, second, third = lines[0].strip(), lines[1].strip(), lines[2].strip()
    if not boot:
        raise BootstrapError("no temporary token of ppm-bot on stdin")
    base = os.environ.get("PPM_FORGEJO_URL", "http://forgejo:3000")
    hook_url = os.environ.get("PPM_FORGEJO_HOOK_URL", "http://api:8000/api/ppm/v1/git/forgejo/webhook/")
    forgejo = Forgejo(base, boot)
    if command == "prepare":
        token = prepare(forgejo, second, third, rotate, hook_url)
        if token:
            sys.stdout.write(f"token={token}\n")
    elif command == "finish":
        finish(forgejo, second)
    elif command == "cleanup":
        cleanup(forgejo)
    else:
        reset_password(forgejo, user)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except BootstrapError as error:
        say(f"FAILED: {error}")
        sys.exit(1)
