#!/usr/bin/env python3
"""Create the FIRST PPM instance administrator (the owner's account) — RUNBOOK §6.

Run through ``ppm-deploy.sh claim-admin``: inside the deployment network, straight to the API service
(``http://api:8000``), so it works in the private setup phase before any port is exposed to the Internet.
The owner types the password (not echoed); it is never printed, logged or stored. Telemetry is switched off.
Refuses when an administrator already exists. ``--password-file`` exists for test stands only.
"""

import argparse
import getpass
import re
import sys
from urllib.parse import parse_qs, urlparse

import requests

API = "http://api:8000"  # `api` is in ALLOWED_HOSTS; plain HTTP stays inside the Compose network
MESSAGES = {
    "ADMIN_ALREADY_EXIST": "Администратор инстанса уже создан — повторно назначить нельзя.",
    "INVALID_ADMIN_EMAIL": "Некорректный e-mail.",
    "INVALID_ADMIN_PASSWORD": "Слишком простой пароль: нужен длинный пароль из разных символов.",
    "REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME": "Нужны e-mail, пароль и имя.",
}


def fail(message):
    print(f"claim-admin: {message}", file=sys.stderr)
    sys.exit(1)


def read_password(path):
    if path:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    if not sys.stdin.isatty():
        fail("пароль вводится только в терминале (владелец вводит его сам)")
    first = getpass.getpass("Пароль администратора (не отображается): ")
    second = getpass.getpass("Повторите пароль: ")
    if first != second:
        fail("пароли не совпадают")
    return first


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--email")
    parser.add_argument("--first-name", default="")
    parser.add_argument("--password-file")
    args = parser.parse_args()

    email = (args.email or input("E-mail администратора: ")).strip()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        fail("некорректный e-mail")
    first_name = args.first_name or ("" if args.password_file else input("Имя (как показывать в PPM): ").strip())
    password = read_password(args.password_file)
    if len(password) < 12:
        fail("пароль короче 12 символов")

    session = requests.Session()
    try:
        csrf = session.get(f"{API}/auth/get-csrf-token/", timeout=30)
        csrf.raise_for_status()
        token = csrf.json()["csrf_token"]
        cookie = csrf.cookies.get("csrftoken")
        # The CSRF cookie is marked Secure (the public origin is https); inside the network the request is plain
        # HTTP, so it is passed explicitly. No Origin header: Django then checks the cookie/token pair only.
        response = session.post(
            f"{API}/api/instances/admins/sign-up/",
            data={
                "email": email,
                "password": password,
                "first_name": first_name or "Администратор",
                "last_name": "",
                "company_name": "PPM",
                "is_telemetry_enabled": "False",
            },
            headers={"X-CSRFToken": token, "Cookie": f"csrftoken={cookie}"},
            allow_redirects=False,
            timeout=60,
        )
    except requests.RequestException as error:
        fail(f"API недоступен ({type(error).__name__}); проверьте ppm-deploy.sh status")
    query = parse_qs(urlparse(response.headers.get("Location", "")).query)
    code = (query.get("error_code") or [""])[0]
    key = (query.get("error_message") or [""])[0]
    if response.status_code not in (301, 302, 303) or code:
        fail(MESSAGES.get(key, f"API отказал (HTTP {response.status_code}{', ' + key if key else ''})"))
    print(f"claim-admin: администратор инстанса создан ({email}); телеметрия выключена.")
    print("claim-admin: пароль нигде не сохранён. Следующий шаг — ppm_global_admin grant (RUNBOOK §6).")


if __name__ == "__main__":
    main()
