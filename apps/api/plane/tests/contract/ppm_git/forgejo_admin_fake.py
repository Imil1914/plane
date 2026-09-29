"""In-memory Forgejo 15 admin API for the G2.2 access engine tests (line S2a).

Built from the answers of a live Forgejo 15.0.9 (S2a report §0: disposable container, the bundle's pinned image) and
the v15.0.9 sources. It answers like the live server where the access engine depends on it:

- ``POST /admin/users`` keeps ``must_change_password`` **true** unless the body says false (Forgejo's default), needs a
  password without ``source_id``, refuses an unknown source (422), a taken name — users and organizations share one
  case-insensitive namespace — (422 ``user already exists``), a taken e-mail, primary or not (422 ``e-mail already in
  use``), a reserved name or ``*.keys``-like pattern and an invalid or longer than 40 characters name (422), a full name
  longer than 100 characters (422); the same ``login_name`` twice is accepted (Forgejo has no such uniqueness);
- ``PATCH /admin/users/{u}`` wants ``source_id`` and ``login_name`` together (422), answers a taken e-mail with **400**;
- ``GET /admin/users?source_id=&login_name=`` compares ``login_name`` exactly (case-sensitive);
- ``GET /admin/emails/search?q=`` is a case-insensitive substring match over e-mails, names and full names of people;
- ``GET /users/{name}`` answers an organization too; ``GET /orgs/{name}`` answers only organizations;
- ``PATCH /orgs/{o}`` overwrites description, website and location with what is sent (empty when missing);
- a non-admin team without ``units_map`` is refused with 500; an admin team gets every unit; team names are unique per
  organization without case (422 on create, **500** on rename); a PATCH cuts a description longer than 255 **bytes**
  (and breaks the last character, as the live server does); the Owners team is never touched by PPM (asserted);
- ``PUT``/``DELETE`` of a team member or a team repository are idempotent (204); the ``{org}`` segment of a team
  repository path is ignored (the repository is looked up by name in the team's organization);
- ``Sudo: <login>`` makes the request act as that person (``/user/teams``, ``/user/repos``), prohibited or not;
- a wrong token is answered 401 with the token echoed (the client must hide it).

Every request is recorded (method, path, params, body, sudo). Any request it does not model fails the test loudly.
``clock``/``seconds_per_request`` let a test spend the access engine's time budget.
"""

import itertools
import re
from urllib.parse import unquote

from plane.tests.contract.ppm_git.forgejo_fake import FORGEJO_SETTINGS, INTERNAL_URL, PUBLIC_URL, FakeResponse

ADMIN_TOKEN = "fake-forgejo-admin-token-000000000000000002"
SOURCE_ID = 2
SSO_SETTINGS = {
    **FORGEJO_SETTINGS,
    "PPM_GIT_SSO_ENABLED": True,
    "PPM_FORGEJO_ADMIN_TOKEN": ADMIN_TOKEN,
    "PPM_FORGEJO_SSO_SOURCE_ID": SOURCE_ID,
}
MAX_RESPONSE_ITEMS = 50
DEFAULT_PAGING_NUM = 30
ALL_UNITS = (
    "repo.code",
    "repo.issues",
    "repo.ext_issues",
    "repo.wiki",
    "repo.ext_wiki",
    "repo.pulls",
    "repo.releases",
    "repo.projects",
    "repo.packages",
    "repo.actions",
)
ACCESS_ORDER = {"none": 0, "read": 1, "write": 2, "admin": 3, "owner": 4}
USERNAME = re.compile(r"^[\da-zA-Z][-.\w]*$", re.ASCII)
INVALID_USERNAME = re.compile(r"[-._]{2,}|[-._]$")
TEAM_NAME = re.compile(r"^[\w\-.]+$", re.ASCII)
RESERVED = {
    ".",
    "..",
    "-",
    ".well-known",
    "api",
    "metrics",
    "v2",
    "assets",
    "attachments",
    "avatar",
    "avatars",
    "repo-avatars",
    "captcha",
    "login",
    "org",
    "repo",
    "user",
    "admin",
    "explore",
    "issues",
    "pulls",
    "milestones",
    "notifications",
    "report_abuse",
    "favicon.ico",
    "manifest.json",
    "robots.txt",
    "sitemap.xml",
    "ssh_info",
    "swagger.v1.json",
    "ghost",
    "gitea-actions",
    "forgejo-actions",
}
RESERVED_PATTERNS = (".keys", ".gpg", ".rss", ".atom", ".png")


def _message(status, message, errors=None):
    return FakeResponse(status, {"message": message, "errors": errors, "url": f"{PUBLIC_URL}/api/swagger"})


class FakeForgejoAdminApi:
    def __init__(self, *, token=ADMIN_TOKEN, source_id=SOURCE_ID):
        self.token = token
        self.sources = {source_id}
        self.page_size = MAX_RESPONSE_ITEMS
        self.accounts = {}  # id → user or organization (one namespace, as in Forgejo)
        self.teams = {}
        self.repositories = {}
        self.requests = []
        self.injected = []
        self.clock = 0.0
        self.seconds_per_request = 0.0
        self._ids = itertools.count(1)
        self._team_ids = itertools.count(1)
        self._repository_ids = itertools.count(1)
        self.bot = self.add_user("ppm-bot", email="ppm-bot@git.invalid", is_admin=True)
        self.emergency_admin = self.add_user("git-admin", email="git-admin@git.invalid", is_admin=True)

    # --- state ----------------------------------------------------------------------------------------------------

    def add_user(
        self,
        login,
        *,
        email,
        is_admin=False,
        source_id=0,
        login_name="",
        full_name="",
        prohibit_login=False,
        active=True,
        verified=True,
        extra_emails=(),
        must_change_password=False,
    ):
        account = {
            "id": next(self._ids),
            "kind": "user",
            "login": login,
            "email": email,
            "full_name": full_name,
            "login_name": login_name,
            "source_id": source_id,
            "is_admin": is_admin,
            "prohibit_login": prohibit_login,
            "active": active,
            "restricted": False,
            "must_change_password": must_change_password,
            "emails": [{"email": email, "primary": True, "verified": verified}]
            + [{"email": item, "primary": False, "verified": True} for item in extra_emails],
        }
        self.accounts[account["id"]] = account
        return account

    def add_org(self, name, *, owner="git-admin", full_name="", description="", website="", location=""):
        organization = {
            "id": next(self._ids),
            "kind": "org",
            "login": name,
            "full_name": full_name,
            "description": description,
            "website": website,
            "location": location,
            "visibility": "private",
            "email": "",
        }
        self.accounts[organization["id"]] = organization
        owners = self._new_team(
            organization,
            name="Owners",
            description="",
            permission="owner",
            units_map={unit: "owner" for unit in ALL_UNITS},
            can_create_org_repo=True,
            includes_all_repositories=True,
        )
        owners["members"].add(self.find(owner)["id"])
        organization["owners_team"] = owners["id"]
        return organization

    def add_team(self, org, name, *, permission="write", units_map=None, members=(), repositories=(), description=""):
        organization = self.find(org)
        if permission == "admin":
            units = {unit: "admin" for unit in ALL_UNITS}
        else:
            units = dict(units_map or {unit: permission for unit in ("repo.code", "repo.pulls")})
        team = self._new_team(
            organization,
            name=name,
            description=description,
            permission=permission,
            units_map=units,
            can_create_org_repo=permission == "admin",
            includes_all_repositories=False,
        )
        team["members"].update(self.find(login)["id"] for login in members)
        team["repositories"].update(self.repository(full_name)["id"] for full_name in repositories)
        return team

    def add_repository(self, owner, name, *, private=True):
        repository = {
            "id": next(self._repository_ids),
            "owner_id": self.find(owner)["id"],
            "name": name,
            "private": private,
        }
        self.repositories[repository["id"]] = repository
        return repository

    def find(self, login):
        key = login.casefold()
        return next((item for item in self.accounts.values() if item["login"].casefold() == key), None)

    def user(self, login):
        found = self.find(login)
        return found if found and found["kind"] == "user" else None

    def org(self, name):
        found = self.find(name)
        return found if found and found["kind"] == "org" else None

    def team(self, org, name):
        organization = self.find(org)
        return next(
            (
                team
                for team in self.teams.values()
                if team["org_id"] == organization["id"] and team["name"].casefold() == name.casefold()
            ),
            None,
        )

    def org_teams(self, org):
        organization = self.find(org)
        return sorted(
            (team for team in self.teams.values() if team["org_id"] == organization["id"]), key=lambda t: t["id"]
        )

    def members(self, team):
        return sorted(self.accounts[member]["login"] for member in team["members"])

    def team_repositories(self, team):
        return sorted(self._full_name(self.repositories[item]) for item in team["repositories"])

    def repository(self, full_name):
        owner, name = full_name.split("/")
        account = self.find(owner)
        return next(
            item
            for item in self.repositories.values()
            if item["owner_id"] == account["id"] and item["name"].casefold() == name.casefold()
        )

    def inject(self, method, path_pattern, response, *, times=1):
        """The next ``times`` matching requests get ``response`` (a FakeResponse, or an exception to raise)."""
        self.injected.append([method, re.compile(path_pattern), response, times])

    def writes(self):
        return [item for item in self.requests if item["method"] != "GET"]

    def calls(self, method, path_pattern):
        pattern = re.compile(path_pattern)
        return [item for item in self.requests if item["method"] == method and pattern.search(item["path"])]

    # --- HTTP entry point -------------------------------------------------------------------------------------------

    def request(self, method, url, headers=None, params=None, json=None, timeout=None, **kwargs):
        assert url.startswith(f"{INTERNAL_URL}/api/v1/"), f"Unexpected host (only the internal address): {url}"
        # The client's timeouts, or less: a sign-in bounds every request by what is left of its budget.
        assert isinstance(timeout, tuple) and 0 < timeout[0] <= 5 and 0 < timeout[1] <= 15, f"Bad timeout: {timeout}"
        assert not kwargs.get("data"), "Bodies are JSON only"
        headers = headers or {}
        path = url[len(f"{INTERNAL_URL}/api/v1") :]
        params = {key: value for key, value in (params or {}).items() if value is not None}
        sudo = headers.get("Sudo")
        self.requests.append(
            {"method": method, "path": path, "params": params, "body": json, "sudo": sudo, "timeout": timeout}
        )
        self.clock += self.seconds_per_request
        for entry in self.injected:
            entry_method, pattern, response, times = entry
            if times > 0 and entry_method == method and pattern.search(path):
                entry[3] -= 1
                if isinstance(response, BaseException):
                    raise response
                return response
        value = headers.get("Authorization", "")
        if not value:
            return _message(401, "token is required")
        if value != f"token {self.token}":
            sent = value.removeprefix("token ")
            return _message(401, f"access token does not exist [sha: {sent}]")
        doer = self.bot
        if sudo:
            doer = self.user(sudo)
            if doer is None:
                return _message(404, "The target couldn't be found.", [])
        return self._dispatch(method, path, params, json, doer)

    def _dispatch(self, method, path, params, body, doer):
        routes = [
            ("GET", r"/user", lambda: FakeResponse(200, self._user_json(doer))),
            ("GET", r"/user/teams", lambda: self._paged(params, [self._team_json(t) for t in self._teams_of(doer)])),
            ("GET", r"/user/repos", lambda: self._paged(params, self._repositories_of(doer))),
            ("GET", r"/admin/users", lambda: self._search_users(params)),
            ("POST", r"/admin/users", lambda: self._create_user(body)),
            ("GET", r"/admin/emails/search", lambda: self._search_emails(params)),
            ("GET", r"/admin/orgs", lambda: self._paged(params, [self._org_json(o) for o in self._orgs()])),
            ("POST", r"/orgs", lambda: self._create_org(body, doer)),
        ]
        for route_method, pattern, handler in routes:
            if method == route_method and re.fullmatch(pattern, path):
                return handler()
        match = re.fullmatch(r"/admin/users/([^/]+)", path)
        if match and method == "PATCH":
            return self._edit_user(unquote(match.group(1)), body)
        match = re.fullmatch(r"/users/([^/]+)", path)
        if match and method == "GET":
            account = self.find(unquote(match.group(1)))
            if account is None:
                return _message(404, f"user redirect does not exist [name: {unquote(match.group(1))}]")
            return FakeResponse(200, self._user_json(account))
        match = re.fullmatch(r"/orgs/([^/]+)(/teams)?", path)
        if match:
            organization = self.org(unquote(match.group(1)))
            if organization is None:
                return _message(404, "GetOrgByName", [f"user redirect does not exist [name: {match.group(1)}]"])
            if match.group(2) and method == "GET":
                return self._paged(
                    params, [self._team_json(t, with_org=False) for t in self.org_teams(organization["login"])]
                )
            if match.group(2) and method == "POST":
                return self._create_team(organization, body)
            if method == "GET":
                return FakeResponse(200, self._org_json(organization))
            if method == "PATCH":
                return self._edit_org(organization, body)
        match = re.fullmatch(r"/teams/(\d+)(/members(?:/([^/]+))?|/repos(?:/([^/]+)/([^/]+))?)?", path)
        if match:
            team = self.teams.get(int(match.group(1)))
            if team is None:
                return _message(404, "The target couldn't be found.", [])
            return self._team_endpoint(method, team, match, params, body)
        match = re.fullmatch(r"/repositories/(\d+)", path)
        if match and method == "GET":
            repository = self.repositories.get(int(match.group(1)))
            if repository is None:
                return _message(404, "The target couldn't be found.", [])
            return FakeResponse(200, self._repository_json(repository, doer))
        match = re.fullmatch(r"/repos/([^/]+)/([^/]+)/collaborators/([^/]+)/permission", path)
        if match and method == "GET":
            repository = self.repository(f"{match.group(1)}/{match.group(2)}")
            person = self.user(unquote(match.group(3)))
            mode = self._access(person, repository)
            name = "admin" if mode in ("admin", "owner") else mode
            return FakeResponse(200, {"permission": name, "role_name": name, "user": self._user_json(person)})
        raise AssertionError(f"Unexpected Forgejo admin request: {method} {path}")

    # --- users ----------------------------------------------------------------------------------------------------

    def _name_refusal(self, name, *, field="Username"):
        if not isinstance(name, str) or not name:
            return _message(422, f"[{field}]: Required")
        if len(name) > 40:
            return _message(422, f"[{field}]: MaxSize")
        if not USERNAME.match(name) or INVALID_USERNAME.search(name):
            return _message(422, f"[{field}]: invalid username")
        if name.casefold() in RESERVED:
            return _message(422, f"name is reserved [name: {name}]")
        for suffix in RESERVED_PATTERNS:
            if name.casefold().endswith(suffix):
                return _message(422, f"name pattern is not allowed [pattern: *{suffix}]")
        if self.find(name) is not None:
            return _message(422, f"user already exists [name: {name}]")
        return None

    def _email_owner(self, email):
        key = email.casefold()
        for account in self.accounts.values():
            if account["kind"] == "user" and any(item["email"].casefold() == key for item in account["emails"]):
                return account
        return None

    def _create_user(self, body):
        body = body or {}
        refusal = self._name_refusal(body.get("username"))
        if refusal is not None:
            return refusal
        if len(body.get("full_name") or "") > 100:
            return _message(422, "[FullName]: MaxSize")
        email = body.get("email") or ""
        if "@" not in email:
            return _message(422, "[Email]: Required")
        source_id = body.get("source_id") or 0
        if source_id and source_id not in self.sources:
            return _message(422, f"login source does not exist [id: {source_id}]")
        if not source_id and len(body.get("password") or "") < 12:
            return _message(400, "PasswordIsRequired")
        if self._email_owner(email) is not None:
            return _message(422, f"e-mail already in use [email: {email}]")
        account = self.add_user(
            body["username"],
            email=email,
            full_name=body.get("full_name") or "",
            source_id=source_id,
            login_name=body.get("login_name") or "",
            must_change_password=body.get("must_change_password", True) is not False,
        )
        return FakeResponse(201, self._user_json(account))

    def _edit_user(self, login, body):
        account = self.user(login)
        if account is None:
            return _message(404, f"user redirect does not exist [name: {login}]")
        body = body or {}
        if ("source_id" in body) != ("login_name" in body):
            return _message(422, "source_id and login_name must be specified together")
        if "source_id" in body:
            if body["source_id"] and body["source_id"] not in self.sources:
                return _message(422, f"login source does not exist [id: {body['source_id']}]")
            account["source_id"] = body["source_id"]
            account["login_name"] = body["login_name"]
        if "email" in body and body["email"].casefold() != account["email"].casefold():
            owner = self._email_owner(body["email"])
            if owner is not None and owner["id"] != account["id"]:
                return _message(400, f"e-mail already in use [email: {body['email']}]")
            account["emails"] = [
                item for item in account["emails"] if item["email"].casefold() != body["email"].casefold()
            ]
            for item in account["emails"]:
                item["primary"] = False
            account["emails"].insert(0, {"email": body["email"], "primary": True, "verified": True})
            account["email"] = body["email"]
        if "full_name" in body:
            if len(body["full_name"]) > 100:
                return _message(422, "[FullName]: MaxSize")
            account["full_name"] = body["full_name"]
        for key, field in (
            ("admin", "is_admin"),
            ("prohibit_login", "prohibit_login"),
            ("active", "active"),
            ("must_change_password", "must_change_password"),
        ):
            if key in body:
                account[field] = body[key]
        return FakeResponse(200, self._user_json(account))

    def _search_users(self, params):
        found = [account for account in self.accounts.values() if account["kind"] == "user"]
        if str(params.get("source_id", "")).isdigit():
            found = [account for account in found if account["source_id"] == int(params["source_id"])]
        if params.get("login_name"):
            found = [account for account in found if account["login_name"] == params["login_name"]]
        found.sort(key=lambda account: account["login"].casefold())
        return self._paged(params, [self._user_json(account) for account in found])

    def _search_emails(self, params):
        query = str(params.get("q") or "").casefold()
        found = []
        for account in sorted(self.accounts.values(), key=lambda item: item["id"]):
            if account["kind"] != "user":
                continue
            person_match = query in account["login"].casefold() or query in account["full_name"].casefold()
            for item in account["emails"]:
                if person_match or query in item["email"].casefold():
                    found.append(
                        {
                            "email": item["email"],
                            "verified": item["verified"],
                            "primary": item["primary"],
                            "user_id": account["id"],
                            "username": account["login"],
                        }
                    )
        found.sort(key=lambda item: item["email"])
        return self._paged(params, found)

    # --- organizations --------------------------------------------------------------------------------------------

    def _orgs(self):
        return sorted((item for item in self.accounts.values() if item["kind"] == "org"), key=lambda item: item["id"])

    def _create_org(self, body, doer):
        body = body or {}
        refusal = self._name_refusal(body.get("username"), field="UserName")
        if refusal is not None:
            return refusal
        organization = self.add_org(body["username"], owner=doer["login"], full_name=body.get("full_name") or "")
        organization["visibility"] = body.get("visibility") or "public"
        return FakeResponse(201, self._org_json(organization))

    def _edit_org(self, organization, body):
        body = body or {}
        # As live: every text field takes what is sent — a missing one becomes empty.
        for key in ("full_name", "description", "website", "location"):
            organization[key] = body.get(key) or ""
        if body.get("visibility"):
            organization["visibility"] = body["visibility"]
        return FakeResponse(200, self._org_json(organization))

    # --- teams ----------------------------------------------------------------------------------------------------

    def _new_team(self, organization, **fields):
        team = {
            "id": next(self._team_ids),
            "org_id": organization["id"],
            "members": set(),
            "repositories": set(),
            **fields,
        }
        self.teams[team["id"]] = team
        return team

    def _team_permission(self, permission, units_map):
        if permission in ("admin", "owner"):
            return permission, {unit: permission for unit in ALL_UNITS}
        values = [value for value in units_map.values()]
        return min(values, key=lambda value: ACCESS_ORDER.get(value, 0)), dict(units_map)

    def _create_team(self, organization, body):
        body = body or {}
        name = body.get("name") or ""
        if not name or not TEAM_NAME.match(name) or len(name) > 255:
            return _message(422, "[Name]: AlphaDashDot")
        permission = body.get("permission") or "read"
        units_map = body.get("units_map") or {}
        if permission != "admin" and not units_map and not body.get("units"):
            return _message(500, "units permission should not be empty")
        if self.team(organization["login"], name) is not None:
            return _message(422, f"team already exists [org_id: {organization['id']}, name: {name.casefold()}]")
        permission, units_map = self._team_permission(permission, units_map)
        team = self._new_team(
            organization,
            name=name,
            description=body.get("description") or "",
            permission=permission,
            units_map=units_map,
            can_create_org_repo=body.get("can_create_org_repo") is True,
            includes_all_repositories=body.get("includes_all_repositories") is True,
        )
        return FakeResponse(201, self._team_json(team))

    def _team_endpoint(self, method, team, match, params, body):
        organization = self.accounts[team["org_id"]]
        owners = team["id"] == organization.get("owners_team")
        section = match.group(2) or ""
        if not section:
            if method == "GET":
                return FakeResponse(200, self._team_json(team))
            assert not owners, "PPM must never change or delete the Owners team"
            if method == "DELETE":
                del self.teams[team["id"]]
                return FakeResponse(204)
            if method == "PATCH":
                return self._edit_team(team, organization, body or {})
        if section.startswith("/members"):
            if match.group(3) is None:
                assert method == "GET"
                members = sorted((self.accounts[item] for item in team["members"]), key=lambda item: item["id"])
                return self._paged(params, [self._user_json(item) for item in members])
            assert not owners, "PPM must never change the members of the Owners team"
            person = self.user(unquote(match.group(3)))
            if person is None:
                return _message(404, "GetUserByName", [f"user does not exist [uid: 0, name: {match.group(3)}]"])
            if method == "PUT":
                team["members"].add(person["id"])
                return FakeResponse(204)
            if method == "DELETE":
                team["members"].discard(person["id"])
                return FakeResponse(204)
        if section.startswith("/repos"):
            if match.group(4) is None:
                assert method == "GET"
                repositories = sorted((self.repositories[item] for item in team["repositories"]), key=lambda r: r["id"])
                return self._paged(params, [self._repository_json(item, self.bot) for item in repositories])
            assert not owners, "PPM must never change the repositories of the Owners team"
            # As live: the `{org}` segment is ignored — the repository is looked up by name in the team's organization.
            name = unquote(match.group(5)).casefold()
            repository = next(
                (
                    item
                    for item in self.repositories.values()
                    if item["owner_id"] == team["org_id"] and item["name"].casefold() == name
                ),
                None,
            )
            if repository is None:
                return _message(404, "The target couldn't be found.", [])
            if method == "PUT":
                team["repositories"].add(repository["id"])
                return FakeResponse(204)
            if method == "DELETE":
                team["repositories"].discard(repository["id"])
                return FakeResponse(204)
        raise AssertionError(f"Unexpected Forgejo team request: {method} {match.group(0)}")

    def _edit_team(self, team, organization, body):
        if body.get("name"):
            clash = self.team(organization["login"], body["name"])
            if clash is not None and clash["id"] != team["id"]:
                return _message(
                    500, f"team already exists [org_id: {organization['id']}, name: {body['name'].casefold()}]"
                )
            team["name"] = body["name"]
        if "description" in body:
            raw = body["description"].encode("utf-8")
            # As live: `UpdateTeam` cuts the description at 255 bytes, breaking a multi-byte character.
            team["description"] = raw[:255].decode("utf-8", errors="replace") if len(raw) > 255 else body["description"]
        if "can_create_org_repo" in body:
            team["can_create_org_repo"] = body["can_create_org_repo"] is True
        if body.get("permission"):
            permission, units_map = self._team_permission(
                body["permission"], body.get("units_map") or team["units_map"]
            )
            team["permission"] = permission
            team["units_map"] = units_map
            if "includes_all_repositories" in body:
                team["includes_all_repositories"] = body["includes_all_repositories"] is True
        elif body.get("units_map") and team["permission"] not in ("admin", "owner"):
            team["units_map"] = dict(body["units_map"])
        return FakeResponse(200, self._team_json(team))

    def _teams_of(self, person):
        return sorted((team for team in self.teams.values() if person["id"] in team["members"]), key=lambda t: t["id"])

    # --- access ---------------------------------------------------------------------------------------------------

    def _access(self, person, repository):
        if person is None:
            return "none"
        if person["is_admin"]:
            return "admin"
        best = "none"
        for team in self.teams.values():
            if person["id"] not in team["members"] or team["org_id"] != repository["owner_id"]:
                continue
            if team["includes_all_repositories"] or repository["id"] in team["repositories"]:
                if ACCESS_ORDER[team["permission"]] > ACCESS_ORDER[best]:
                    best = team["permission"]
        return best

    def _repositories_of(self, person):
        found = []
        for repository in sorted(self.repositories.values(), key=lambda item: item["id"]):
            mode = self._access(person, repository)
            if mode != "none":
                found.append(self._repository_json(repository, person))
        return found

    # --- answers --------------------------------------------------------------------------------------------------

    @staticmethod
    def _page_window(params):
        page = max(int(params.get("page") or 1), 1)
        limit = int(params.get("limit") or DEFAULT_PAGING_NUM)
        return page, min(max(limit, 1), MAX_RESPONSE_ITEMS)

    def _paged(self, params, items):
        page, limit = self._page_window(params)
        chunk = items[(page - 1) * limit : page * limit]
        headers = {"X-Total-Count": str(len(items))}
        if page * limit < len(items):
            headers["Link"] = f'<{PUBLIC_URL}/api/v1/next?page={page + 1}>; rel="next"'
        return FakeResponse(200, chunk, headers)

    def _full_name(self, repository):
        return f"{self.accounts[repository['owner_id']]['login']}/{repository['name']}"

    def _user_json(self, account):
        return {
            "id": account["id"],
            "login": account["login"],
            "login_name": account.get("login_name", ""),
            "source_id": account.get("source_id", 0),
            "full_name": account.get("full_name", ""),
            "email": account.get("email", ""),
            "avatar_url": f"{PUBLIC_URL}/avatars/{account['id']}",
            "html_url": f"{PUBLIC_URL}/{account['login']}",
            "language": "",
            "is_admin": account.get("is_admin", False),
            "last_login": "1970-01-01T00:00:00Z",
            "created": "2026-09-29T00:00:00Z",
            "restricted": account.get("restricted", False),
            "active": account.get("active", False) if account["kind"] == "user" else False,
            "prohibit_login": account.get("prohibit_login", False),
            "location": account.get("location", ""),
            "pronouns": "",
            "website": account.get("website", ""),
            "description": account.get("description", ""),
            "visibility": account.get("visibility", "public"),
            "followers_count": 0,
            "following_count": 0,
            "starred_repos_count": 0,
            "username": account["login"],
        }

    def _org_json(self, organization):
        return {
            "id": organization["id"],
            "name": organization["login"],
            "full_name": organization["full_name"],
            "email": organization.get("email", ""),
            "avatar_url": f"{PUBLIC_URL}/avatars/{organization['id']}",
            "description": organization["description"],
            "website": organization["website"],
            "location": organization["location"],
            "visibility": organization["visibility"],
            "repo_admin_change_team_access": False,
            "username": organization["login"],
        }

    def _team_json(self, team, *, with_org=True):
        return {
            "id": team["id"],
            "name": team["name"],
            "description": team["description"],
            "organization": self._org_json(self.accounts[team["org_id"]]) if with_org else None,
            "includes_all_repositories": team["includes_all_repositories"],
            "permission": team["permission"],
            "units": sorted(team["units_map"]),
            "units_map": dict(team["units_map"]),
            "can_create_org_repo": team["can_create_org_repo"],
        }

    def _repository_json(self, repository, viewer):
        owner = self.accounts[repository["owner_id"]]
        mode = self._access(viewer, repository)
        full_name = self._full_name(repository)
        return {
            "id": repository["id"],
            "owner": self._user_json(owner),
            "name": repository["name"],
            "full_name": full_name,
            "description": "",
            "empty": False,
            "private": repository["private"],
            "fork": False,
            "mirror": False,
            "html_url": f"{PUBLIC_URL}/{full_name}",
            "clone_url": f"{PUBLIC_URL}/{full_name}.git",
            "default_branch": "main",
            "archived": False,
            "permissions": {
                "admin": mode in ("admin", "owner"),
                "push": mode in ("write", "admin", "owner"),
                "pull": mode != "none",
            },
        }
