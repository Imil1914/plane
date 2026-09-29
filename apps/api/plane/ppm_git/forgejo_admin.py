"""G2.2 R8 — writes to PPM's own Git server (Forgejo 15) for the access engine (``forgejo_access``).

The service account ppm-bot, a Forgejo site administrator, acts with its administration token
``PPM_FORGEJO_ADMIN_TOKEN`` (scopes ``write:admin,write:organization,read:repository,read:user``) over the internal
address ``PPM_FORGEJO_URL``; only the access engine holds it — the read-only provider token of G2.1 stays as it is. The
transport follows ``providers.forgejo.ForgejoClient``: the token is read from the settings for each request and kept
nowhere on the client, the same timeouts, 429 and gateway answers mean «come back later», pages go by ``page``/``limit``
until ``X-Total-Count``, and no text of a Forgejo answer ever reaches an exception or a log — refusals the engine acts
on are classified here into safe codes (``FORGEJO_NAME_TAKEN``, ``FORGEJO_EMAIL_TAKEN``, …).

Checked against a live Forgejo 15.0.9 (S2a report §0) and its v15.0.9 sources:

- an account is created with ``source_id`` + ``login_name`` and without a password, always with
  ``must_change_password: false`` — Forgejo's default is true, which breaks sign-in, the API and git;
- a PATCH of an account always carries ``source_id`` and ``login_name`` together (Forgejo refuses one without the
  other; with both it re-asserts the binding to PPM's sign-in source);
- a taken e-mail is 422 on create but 400 on PATCH; a taken name (people and organizations share one namespace) and a
  reserved, patterned, invalid or longer than 40 characters name are 422;
- ``GET /users/{name}`` answers an organization too — one check tells whether a name is free;
- ``PATCH /orgs/{org}`` overwrites description, website and location with what is sent: they are always sent back;
- a non-admin team needs ``units_map`` (500 without it); an admin team gets every unit by itself;
- a taken team name is 422 on create but **500** on rename — both become ``FORGEJO_TEAM_EXISTS``;
- ``Sudo: <login>`` makes a request act as that person (their teams and repositories), prohibited or not;
- the ``{org}`` segment of ``/teams/{id}/repos/{org}/{repo}`` is ignored by Forgejo: the repository is looked up by
  name in the team's organization.
"""

from urllib.parse import quote

import requests
from django.conf import settings

from .providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from .providers.forgejo import (
    PAGE_SIZE,
    REQUEST_TIMEOUT,
    TOKEN_PATTERN,
    WAIT_STATUSES,
    _retry_after_seconds,
    _total_count,
)


# The units a PPM team grants (R12): code, pull requests, issues, releases, wiki. A non-admin team gets exactly these
# with its own access; the others stay closed.
TEAM_UNITS = ("repo.code", "repo.pulls", "repo.issues", "repo.releases", "repo.wiki")
# A listing longer than this many pages is refused rather than read without end (50 × 200 = 10 000 items).
MAX_PAGES = 200

ADMIN_AUTH_FAILED_MESSAGE = (
    "Git-сервер не принял служебный токен администрирования PPM. Администратору сервера: перевыпустите его командой "
    "ppm-deploy.sh git-bootstrap --rotate-token."
)
NOT_CONFIGURED = ("GIT_PROVIDER_NOT_CONFIGURED", "Единый вход на Git-сервер ещё не настроен администратором сервера.")
UNAVAILABLE = ("GIT_PROVIDER_UNAVAILABLE", "Git-сервер недоступен.")
RATE_LIMITED = ("GIT_PROVIDER_RATE_LIMITED", "Git-сервер просит подождать. PPM повторит запрос позже.")
NOT_FOUND = ("GIT_PROVIDER_NOT_FOUND", "Объект не найден на Git-сервере.")
REQUEST_FAILED = ("GIT_PROVIDER_REQUEST_FAILED", "Git-сервер не выполнил запрос.")
INVALID_RESPONSE = ("GIT_PROVIDER_INVALID_RESPONSE", "Git-сервер вернул некорректный ответ.")
PAGE_LIMIT = ("GIT_PROVIDER_PAGE_LIMIT", "Git-сервер вернул слишком большой набор данных.")
NAME_TAKEN = ("FORGEJO_NAME_TAKEN", "Имя уже занято на Git-сервере.")
NAME_INVALID = ("FORGEJO_NAME_INVALID", "Git-сервер не принял имя.")
EMAIL_TAKEN = ("FORGEJO_EMAIL_TAKEN", "Почта уже занята другой учёткой на Git-сервере.")
EMAIL_INVALID = ("FORGEJO_EMAIL_INVALID", "Git-сервер не принял почту.")
TEAM_EXISTS = ("FORGEJO_TEAM_EXISTS", "Команда с таким именем уже есть в организации на Git-сервере.")
SOURCE_MISSING = (
    "FORGEJO_SSO_SOURCE_MISSING",
    "На Git-сервере нет источника входа «PPM» с настроенным номером. Администратору сервера: повторите "
    "ppm-deploy.sh git-bootstrap.",
)


def _setting(name):
    value = getattr(settings, name, "")
    return value.strip() if isinstance(value, str) else ""


def _segment(value):
    return quote(str(value), safe="")


def _text(value, *, maximum):
    return value[:maximum] if isinstance(value, str) else ""


def _integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _invalid(status=None):
    return PpmGitProviderError(*INVALID_RESPONSE, http_status=status)


def _person_login(username):
    """The login a ``Sudo`` request acts as. A blank one stops here: without the header the request would act as the
    token's owner — a site administrator."""
    if not isinstance(username, str) or not username.strip():
        raise ValueError("Sudo needs the login of a person")
    return username


def _answer_message(response):
    """Forgejo's own text of a refusal — read only to classify it here, never passed on."""
    try:
        payload = response.json()
    except ValueError:
        return ""
    message = payload.get("message") if isinstance(payload, dict) else None
    return message.casefold() if isinstance(message, str) else ""


def _account_refusal(response):
    """A refused account or organization create/edit → a safe error (live Forgejo 15 texts, S2a report §0)."""
    message = _answer_message(response)
    if "e-mail already in use" in message or "email already in use" in message:
        code, text = EMAIL_TAKEN
    elif "login source does not exist" in message:
        code, text = SOURCE_MISSING
    elif "already exists" in message:
        code, text = NAME_TAKEN
    elif any(
        marker in message for marker in ("is reserved", "pattern is not allowed", "[username]", "invalid username")
    ):
        # `[Username]: invalid username` / `[Username]: MaxSize` (people), `[UserName]: …` (organizations).
        code, text = NAME_INVALID
    elif "email" in message or "e-mail" in message:
        code, text = EMAIL_INVALID
    else:
        code, text = REQUEST_FAILED
    return PpmGitProviderError(code, text, http_status=response.status_code)


def _user(payload):
    if not isinstance(payload, dict):
        raise _invalid()
    user_id = _integer(payload.get("id"))
    login = payload.get("login") or payload.get("username")
    if user_id is None or not isinstance(login, str) or not login or len(login) > 255:
        raise _invalid()
    return {
        "id": user_id,
        "login": login,
        "email": _text(payload.get("email"), maximum=320),
        "full_name": _text(payload.get("full_name"), maximum=255),
        "login_name": _text(payload.get("login_name"), maximum=255),
        "source_id": _integer(payload.get("source_id")) or 0,
        "is_admin": payload.get("is_admin") is True,
        "prohibit_login": payload.get("prohibit_login") is True,
        "active": payload.get("active") is True,
        "restricted": payload.get("restricted") is True,
    }


def _organization(payload):
    if not isinstance(payload, dict):
        raise _invalid()
    organization_id = _integer(payload.get("id"))
    name = payload.get("name") or payload.get("username")
    if organization_id is None or not isinstance(name, str) or not name:
        raise _invalid()
    return {
        "id": organization_id,
        "name": name,
        "full_name": _text(payload.get("full_name"), maximum=255),
        "description": _text(payload.get("description"), maximum=1024),
        "website": _text(payload.get("website"), maximum=1024),
        "location": _text(payload.get("location"), maximum=255),
        "visibility": _text(payload.get("visibility"), maximum=16),
    }


def _team(payload):
    if not isinstance(payload, dict):
        raise _invalid()
    team_id = _integer(payload.get("id"))
    name = payload.get("name")
    if team_id is None or not isinstance(name, str) or not name:
        raise _invalid()
    units = payload.get("units_map")
    organization = payload.get("organization")
    return {
        "id": team_id,
        "name": name,
        "description": _text(payload.get("description"), maximum=1024),
        "permission": _text(payload.get("permission"), maximum=16),
        "units_map": {
            key: value for key, value in (units or {}).items() if isinstance(key, str) and isinstance(value, str)
        }
        if isinstance(units, dict)
        else {},
        "can_create_org_repo": payload.get("can_create_org_repo") is True,
        "includes_all_repositories": payload.get("includes_all_repositories") is True,
        "organization": (organization.get("name") or organization.get("username") or "")
        if isinstance(organization, dict)
        else "",
    }


def _repository(payload):
    if not isinstance(payload, dict):
        raise _invalid()
    repository_id = _integer(payload.get("id"))
    name = payload.get("name")
    full_name = payload.get("full_name")
    owner = payload.get("owner") if isinstance(payload.get("owner"), dict) else {}
    owner_login = owner.get("login") or owner.get("username")
    if (
        repository_id is None
        or not isinstance(name, str)
        or not isinstance(full_name, str)
        or not isinstance(owner_login, str)
    ):
        raise _invalid()
    permissions = payload.get("permissions") if isinstance(payload.get("permissions"), dict) else {}
    return {
        "id": repository_id,
        "name": name,
        "full_name": full_name,
        "owner": owner_login,
        "private": payload.get("private") is True,
        "permissions": {key: permissions.get(key) is True for key in ("admin", "push", "pull")},
    }


class ForgejoAdminClient:
    """Forgejo API v1 client of the access engine: accounts, organizations, teams, their members and repositories.

    The administration token is read from the settings for each request and is kept nowhere on the client.
    """

    def __init__(self, *, session=None, page_size=PAGE_SIZE):
        self.session = session or requests.Session()
        self.page_size = page_size
        # Optional callable giving the (connect, read) timeout of the next request, or raising to stop before it: the
        # access engine bounds every request of a sign-in by what is left of its time budget.
        self.request_timeout = None

    def __repr__(self):
        return "ForgejoAdminClient()"

    # --- accounts -------------------------------------------------------------------------------------------------

    def current_login(self):
        """The account of the administration token (ppm-bot)."""
        return _user(self._object("GET", "/user"))["login"]

    def find_users_by_login(self, source_id, login_name):
        """Accounts bound to one person of a sign-in source: ``login_name`` is compared exactly (case-sensitive)."""
        return [_user(item) for item in self._list("/admin/users", {"source_id": source_id, "login_name": login_name})]

    def list_source_users(self, source_id):
        """Every account of a sign-in source (the full reconciliation reads them in one listing)."""
        return [_user(item) for item in self._list("/admin/users", {"source_id": source_id})]

    def find_email_owners(self, email):
        """Addresses equal to ``email`` (without case), primary or not, with the person holding each.

        ``/admin/emails/search`` matches a substring of e-mails, names and full names; only exact addresses are kept.
        """
        wanted = email.strip().casefold()
        found = []
        for item in self._list("/admin/emails/search", {"q": email.strip()}):
            address = item.get("email")
            user_id = _integer(item.get("user_id"))
            username = item.get("username")
            if not isinstance(address, str) or address.casefold() != wanted:
                continue
            if user_id is None or not isinstance(username, str) or not username:
                raise _invalid()
            found.append(
                {
                    "email": address,
                    "user_id": user_id,
                    "username": username,
                    "primary": item.get("primary") is True,
                    "verified": item.get("verified") is True,
                }
            )
        return found

    def get_user(self, username):
        """A person — or an organization: the name is taken either way — by name; None when the name is free."""
        payload, _ = self._request("GET", f"/users/{_segment(username)}", accept={404})
        return None if payload is None else _user(payload)

    def create_user(self, *, username, email, full_name, source_id, login_name):
        """An account bound to PPM's sign-in source, without a password (live Forgejo 15 body, S2a report §0)."""
        body = {
            "username": username,
            "email": email,
            "full_name": full_name,
            "source_id": source_id,
            "login_name": login_name,
            "must_change_password": False,
        }
        payload, response = self._request("POST", "/admin/users", body=body, accept={400, 422})
        if payload is None:
            raise _account_refusal(response)
        return _user(payload)

    def edit_user(self, username, *, source_id, login_name, **changes):
        """PATCH of an account PPM keeps: ``source_id`` and ``login_name`` always go together with the changes
        (``full_name``, ``email``, ``admin``, ``prohibit_login``, ``active``, ``must_change_password``)."""
        body = {"source_id": source_id, "login_name": login_name, **changes}
        payload, response = self._request("PATCH", f"/admin/users/{_segment(username)}", body=body, accept={400, 422})
        if payload is None:
            raise _account_refusal(response)
        return _user(payload)

    # --- organizations --------------------------------------------------------------------------------------------

    def get_organization(self, name):
        payload, _ = self._request("GET", f"/orgs/{_segment(name)}", accept={404})
        return None if payload is None else _organization(payload)

    def list_organizations(self):
        return [_organization(item) for item in self._list("/admin/orgs", {})]

    def create_organization(self, *, name, full_name):
        """A private organization; the token's account (ppm-bot) becomes its owner."""
        body = {"username": name, "full_name": full_name, "visibility": "private"}
        payload, response = self._request("POST", "/orgs", body=body, accept={422})
        if payload is None:
            raise _account_refusal(response)
        return _organization(payload)

    def edit_organization(self, organization, *, full_name, visibility):
        """Full name and visibility; description, website and location go back as they are (Forgejo would clear
        whatever a PATCH leaves out)."""
        body = {
            "full_name": full_name,
            "visibility": visibility,
            "description": organization["description"],
            "website": organization["website"],
            "location": organization["location"],
        }
        return _organization(self._object("PATCH", f"/orgs/{_segment(organization['name'])}", body=body))

    def list_organization_teams(self, organization):
        return [_team(item) for item in self._list(f"/orgs/{_segment(organization)}/teams", {})]

    # --- teams ----------------------------------------------------------------------------------------------------

    @staticmethod
    def _team_body(*, name, description, permission, can_create_org_repo):
        body = {
            "name": name,
            "description": description,
            "permission": permission,
            "includes_all_repositories": False,
            "can_create_org_repo": can_create_org_repo,
        }
        if permission != "admin":
            # A non-admin team without units is refused (500); its access is the lowest of its units.
            body["units_map"] = {unit: permission for unit in TEAM_UNITS}
        return body

    def get_team(self, team_id):
        payload, _ = self._request("GET", f"/teams/{int(team_id)}", accept={404})
        return None if payload is None else _team(payload)

    def create_team(self, organization, *, name, description, permission, can_create_org_repo):
        body = self._team_body(
            name=name, description=description, permission=permission, can_create_org_repo=can_create_org_repo
        )
        payload, response = self._request("POST", f"/orgs/{_segment(organization)}/teams", body=body, accept={422})
        if payload is None:
            if "already exists" in _answer_message(response):
                raise PpmGitProviderError(*TEAM_EXISTS, http_status=response.status_code)
            raise PpmGitProviderError(*REQUEST_FAILED, http_status=response.status_code)
        return _team(payload)

    def edit_team(self, team_id, *, name, description, permission, can_create_org_repo):
        body = self._team_body(
            name=name, description=description, permission=permission, can_create_org_repo=can_create_org_repo
        )
        payload, response = self._request("PATCH", f"/teams/{int(team_id)}", body=body, accept={500})
        if payload is None:
            # A name taken in the organization is a 500 on rename (live Forgejo 15).
            if "already exists" in _answer_message(response):
                raise PpmGitProviderError(*TEAM_EXISTS, http_status=response.status_code)
            raise PpmGitProviderError(*UNAVAILABLE, http_status=response.status_code)
        return _team(payload)

    def delete_team(self, team_id):
        """True when deleted, False when it was already gone."""
        _, response = self._request("DELETE", f"/teams/{int(team_id)}", accept={404}, expect_body=False)
        return response.status_code != 404

    def list_team_members(self, team_id):
        """Members with what an administrator sees of them (``source_id``, ``login_name``, ``is_admin``): PPM changes
        only the accounts that are its own."""
        return [_user(item) for item in self._list(f"/teams/{int(team_id)}/members", {})]

    def add_team_member(self, team_id, username):
        self._request("PUT", f"/teams/{int(team_id)}/members/{_segment(username)}", expect_body=False)

    def remove_team_member(self, team_id, username):
        self._request("DELETE", f"/teams/{int(team_id)}/members/{_segment(username)}", expect_body=False)

    def list_team_repositories(self, team_id):
        return [_repository(item) for item in self._list(f"/teams/{int(team_id)}/repos", {})]

    def add_team_repository(self, team_id, organization, name):
        self._request(
            "PUT", f"/teams/{int(team_id)}/repos/{_segment(organization)}/{_segment(name)}", expect_body=False
        )

    def remove_team_repository(self, team_id, organization, name):
        self._request(
            "DELETE", f"/teams/{int(team_id)}/repos/{_segment(organization)}/{_segment(name)}", expect_body=False
        )

    # --- repositories ---------------------------------------------------------------------------------------------

    def get_repository(self, repository_id):
        payload, _ = self._request("GET", f"/repositories/{int(repository_id)}", accept={404})
        return None if payload is None else _repository(payload)

    def repository_permission(self, full_name, username):
        """``admin`` / ``write`` / ``read`` / ``none`` of a person on one repository (teams included)."""
        owner, name = full_name.split("/", 1)
        payload = self._object(
            "GET", f"/repos/{_segment(owner)}/{_segment(name)}/collaborators/{_segment(username)}/permission"
        )
        permission = payload.get("permission")
        if not isinstance(permission, str):
            raise _invalid()
        return permission

    def list_repositories_as(self, username):
        """Every repository a person reaches — owned, as a collaborator, through a team — asked as that person (admin
        ``Sudo: <username>``, ``GET /user/repos``, all pages). Whole Forgejo answers, each with the person's own
        ``permissions`` (``admin``/``push``/``pull``): the connect dialog (R17) normalizes them with
        ``providers.forgejo.normalize_forgejo_repository``. An unknown person is ``GIT_PROVIDER_NOT_FOUND``."""
        return self._list("/user/repos", {}, sudo=_person_login(username))

    def list_user_repositories(self, username):
        """``list_repositories_as`` reduced to what the access engine reads (id, names, owner, permissions)."""
        return [_repository(item) for item in self.list_repositories_as(username)]

    def list_user_teams(self, username):
        """Teams a person is in (every organization) — asked as that person (admin sudo)."""
        return [_team(item) for item in self._list("/user/teams", {}, sudo=_person_login(username))]

    # --- transport ------------------------------------------------------------------------------------------------

    def _list(self, path, params, *, sudo=None):
        values = []
        seen = 0
        page = 1
        while True:
            payload, response = self._request(
                "GET", path, params={**params, "page": page, "limit": self.page_size}, sudo=sudo
            )
            if payload is None:
                payload = []
            if not isinstance(payload, list):
                raise _invalid(response.status_code)
            seen += len(payload)
            values.extend(item for item in payload if isinstance(item, dict))
            total = _total_count(response)
            if (
                not payload
                or (total is not None and seen >= total)
                or (total is None and len(payload) < self.page_size)
            ):
                return values
            if page >= MAX_PAGES:
                raise PpmGitProviderError(*PAGE_LIMIT)
            page += 1

    def _object(self, method, path, *, body=None):
        payload, response = self._request(method, path, body=body)
        if not isinstance(payload, dict):
            raise _invalid(response.status_code)
        return payload

    def _request(self, method, path, *, params=None, body=None, sudo=None, accept=frozenset(), expect_body=True):
        """One call; statuses in ``accept`` come back as ``(None, response)`` for the caller to classify."""
        if sudo is not None:
            _person_login(sudo)
        base = _setting("PPM_FORGEJO_URL").rstrip("/")
        token = _setting("PPM_FORGEJO_ADMIN_TOKEN")
        if not base or not token:
            raise PpmGitProviderError(*NOT_CONFIGURED)
        if not TOKEN_PATTERN.fullmatch(token):
            # requests would put the value into its own error text.
            raise PpmGitProviderError("GIT_PROVIDER_AUTH_FAILED", ADMIN_AUTH_FAILED_MESSAGE)
        headers = {"Accept": "application/json", "Authorization": f"token {token}"}
        if sudo is not None:
            headers["Sudo"] = sudo
        timeout = self.request_timeout() if self.request_timeout is not None else REQUEST_TIMEOUT
        try:
            response = self.session.request(
                method,
                f"{base}/api/v1{path}",
                headers=headers,
                params=params,
                json=body,
                timeout=timeout,
            )
        except requests.RequestException:
            # No exception chain: a transport error may describe the request it failed on.
            raise PpmGitProviderError(*UNAVAILABLE) from None

        status = response.status_code
        if status in accept:
            return None, response
        if status in WAIT_STATUSES:
            raise PpmGitProviderRateLimited(
                *RATE_LIMITED,
                retry_after_seconds=_retry_after_seconds(response),
                http_status=status,
            )
        if status in {401, 403}:
            raise PpmGitProviderError("GIT_PROVIDER_AUTH_FAILED", ADMIN_AUTH_FAILED_MESSAGE, http_status=status)
        if status == 404:
            raise PpmGitProviderError(*NOT_FOUND, http_status=status)
        if status >= 500:
            raise PpmGitProviderError(*UNAVAILABLE, http_status=status)
        if status >= 400:
            raise PpmGitProviderError(*REQUEST_FAILED, http_status=status)
        if not expect_body or status == 204:
            return None, response
        try:
            payload = response.json()
        except ValueError:
            raise _invalid(status) from None
        return payload, response
