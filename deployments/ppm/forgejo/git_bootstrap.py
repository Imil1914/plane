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
  prepare [--rotate-token] [--admin-token]
                             [temporary token, current PPM_FORGEJO_TOKEN, PPM_FORGEJO_WEBHOOK_SECRET,
                              current PPM_FORGEJO_ADMIN_TOKEN]
      ppm-bot must be an active administrator; recreates the system webhook to the PPM receiver; keeps the current
      read-only token while it works and has exactly the read scopes, else (or with --rotate-token) creates a NEW
      token `ppm-read-<UTC>` and prints `token=<value>`. With --admin-token (sign-in through PPM, G2.2) the same for
      the admin token of PPM's access module (`ppm-admin-<UTC>`, write:admin, write:organization, read:repository,
      read:user; proven on the admin API before it is handed out), printed as `admin_token=<value>`; --rotate-token
      then renews both. Revokes nothing: ppm-deploy.sh first saves the new tokens and restarts the API.
  finish                     [temporary token, the PPM_FORGEJO_TOKEN now in use, the PPM_FORGEJO_ADMIN_TOKEN now in
                              use or an empty line]
      checks that the read-only token works, can only read and has exactly the read scopes (and the admin token, if
      given, that it works as ppm-bot with exactly the admin scopes), then revokes every other token of ppm-bot
      (previous PPM tokens, leftovers of interrupted runs, the temporary token — and every admin token when none is
      given: sign-in through PPM switched off).
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
# Sign-in through PPM (G2.2 R8): PPM's access module creates accounts, organizations and teams and reads people's
# repositories through admin sudo — and nothing else uses this token.
ADMIN_TOKEN_PREFIX = "ppm-admin"
ADMIN_TOKEN_SCOPES = ["read:repository", "read:user", "write:admin", "write:organization"]
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


def token_entry(tokens, value, prefix=TOKEN_PREFIX, scopes=TOKEN_SCOPES):
    """The listed token of PPM that the value belongs to: our name, the same last eight characters, exact scopes."""
    for entry in tokens:
        if (
            entry.get("name", "").startswith(prefix)
            and value
            and entry.get("token_last_eight") == value[-8:]
            and sorted(entry.get("scopes") or []) == sorted(scopes)
        ):
            return entry
    return None


def admin_token_works(forgejo, token):
    """True when the token signs in as ppm-bot, an administrator, and reaches the admin API (write:admin has read)."""
    try:
        me = forgejo.call("GET", "/user", token=token)
        if not isinstance(me, dict) or me.get("login") != BOT or not me.get("is_admin"):
            return False
        forgejo.call("GET", "/admin/users?limit=1", token=token)
    except BootstrapError:
        return False
    return True


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


# The two tokens PPM holds: (kind, name prefix, exact scopes, what it is called in messages).
READ_TOKEN = ("read", TOKEN_PREFIX, TOKEN_SCOPES, "read-only token")
ADMIN_TOKEN = ("admin", ADMIN_TOKEN_PREFIX, ADMIN_TOKEN_SCOPES, "admin token")


def token_problem(forgejo, kind, created, value, scopes):
    """Why a token just created cannot be handed out, or None."""
    if not value:
        return "Forgejo created the token but returned no value"
    if sorted(created.get("scopes") or []) != sorted(scopes):
        return f"the new {kind} token does not carry exactly its scopes"
    if kind == "read":
        if not token_works(forgejo, value):
            return "the new token does not authenticate as ppm-bot"
        if not read_only(forgejo, value):
            return "the new token is not read-only (a write was not refused)"
    elif not admin_token_works(forgejo, value):
        return "the new admin token does not reach the admin API as ppm-bot"
    return None


def prepare(forgejo, current, secret, rotate, hook_url, admin=False, current_admin=""):
    """Returns {"read": value, "admin": value} for the tokens issued now (none revoked)."""
    if len(secret) < 20:
        raise BootstrapError("PPM_FORGEJO_WEBHOOK_SECRET is missing or shorter than 20 characters")
    check_admin(forgejo)
    ensure_webhook(forgejo, hook_url, secret)
    tokens = forgejo.paged(f"/users/{BOT}/tokens")
    wanted = []
    if not rotate and token_entry(tokens, current) and token_works(forgejo, current):
        say("read-only token of PPM kept (still valid, exact scopes)")
    else:
        wanted.append(READ_TOKEN)
    if admin:
        if (not rotate and token_entry(tokens, current_admin, ADMIN_TOKEN_PREFIX, ADMIN_TOKEN_SCOPES)
                and admin_token_works(forgejo, current_admin)):
            say("admin token of PPM kept (still valid, exact scopes)")
        else:
            wanted.append(ADMIN_TOKEN)
    if not wanted:
        return {}
    names = {entry.get("name") for entry in tokens}
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    issued, created_ids = {}, []
    forgejo.set_bot_password("token")
    try:
        for kind, prefix, scopes, label in wanted:
            name = f"{prefix}-{stamp}"
            while name in names:
                name = f"{name}-{secrets.token_hex(2)}"
            names.add(name)
            created = forgejo.call("POST", f"/users/{BOT}/tokens", {"name": name, "scopes": scopes},
                                   auth="password", expect=(201,)) or {}
            if created.get("id"):
                created_ids.append(created["id"])
            value = created.get("sha1") or ""
            problem = token_problem(forgejo, kind, created, value, scopes)
            if problem:
                raise BootstrapError(problem)
            issued[kind] = (name, label, value)
    except BootstrapError as error:
        # Nothing issued in this run is kept: none of it was saved anywhere yet.
        for token_id in created_ids:
            try:
                forgejo.call("DELETE", f"/users/{BOT}/tokens/{token_id}", auth="password", expect=(204, 404))
            except BootstrapError:
                pass
        raise BootstrapError(f"{error}; the token(s) issued in this run were revoked again") from None
    finally:
        forgejo.forget_bot_password()
    for kind, (name, label, _) in issued.items():
        current_value = current if kind == "read" else current_admin
        reason = "--rotate-token" if rotate else (
            "the current one is missing, invalid or has other scopes" if current_value else "first run")
        say(f"new {label} {name} issued ({reason}); nothing revoked yet")
    return {kind: value for kind, (_, _, value) in issued.items()}


def finish(forgejo, current, current_admin=""):
    check_admin(forgejo)
    tokens = forgejo.paged(f"/users/{BOT}/tokens")
    ours = token_entry(tokens, current)
    if not ours or not token_works(forgejo, current):
        raise BootstrapError("PPM_FORGEJO_TOKEN is not a working read-only token of ppm-bot; nothing was revoked")
    if not read_only(forgejo, current):
        raise BootstrapError("PPM_FORGEJO_TOKEN can write; nothing was revoked")
    kept = [ours]
    if current_admin:
        admin = token_entry(tokens, current_admin, ADMIN_TOKEN_PREFIX, ADMIN_TOKEN_SCOPES)
        if not admin or not admin_token_works(forgejo, current_admin):
            raise BootstrapError("PPM_FORGEJO_ADMIN_TOKEN is not a working admin token of ppm-bot with exactly its "
                                 "scopes; nothing was revoked")
        kept.append(admin)
    kept_ids = {entry.get("id") for entry in kept}
    others = [entry for entry in tokens if entry.get("id") not in kept_ids]
    # The temporary token (this run's credential) goes last.
    others.sort(key=lambda entry: entry.get("name", "").startswith(BOOT_PREFIX))
    forgejo.set_bot_password("token")
    try:
        for entry in others:
            forgejo.call("DELETE", f"/users/{BOT}/tokens/{entry['id']}", auth="password", expect=(204, 404))
    finally:
        forgejo.forget_bot_password()
    stale = sum(1 for entry in others if not entry.get("name", "").startswith(BOOT_PREFIX))
    admins = sum(1 for entry in others if entry.get("name", "").startswith(ADMIN_TOKEN_PREFIX))
    say(f"PPM's token(s) {', '.join(entry.get('name', '') for entry in kept)} are the only tokens of {BOT}: "
        f"{stale} previous token(s)"
        f"{f' (of them {admins} admin token(s): sign-in through PPM is off)' if admins and not current_admin else ''} "
        f"and {len(others) - stale} temporary token(s) revoked; its password is random and unknown")


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
    rotate = admin = False
    user = None
    if command == "prepare":
        for arg in args:
            if arg == "--rotate-token":
                rotate = True
            elif arg == "--admin-token":
                admin = True
            else:
                raise BootstrapError(f"unknown argument {arg}")
    elif command == "reset-password":
        if len(args) != 1:
            raise BootstrapError("reset-password needs exactly one user name")
        user = args[0]
    elif args:
        raise BootstrapError(f"{command} takes no arguments")
    lines = sys.stdin.read().split("\n") + [""] * 4
    boot, second, third, fourth = (line.strip() for line in lines[:4])
    if not boot:
        raise BootstrapError("no temporary token of ppm-bot on stdin")
    base = os.environ.get("PPM_FORGEJO_URL", "http://forgejo:3000")
    hook_url = os.environ.get("PPM_FORGEJO_HOOK_URL", "http://api:8000/api/ppm/v1/git/forgejo/webhook/")
    forgejo = Forgejo(base, boot)
    if command == "prepare":
        issued = prepare(forgejo, second, third, rotate, hook_url, admin=admin, current_admin=fourth)
        if issued.get("read"):
            sys.stdout.write(f"token={issued['read']}\n")
        if issued.get("admin"):
            sys.stdout.write(f"admin_token={issued['admin']}\n")
    elif command == "finish":
        finish(forgejo, second, third)
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
