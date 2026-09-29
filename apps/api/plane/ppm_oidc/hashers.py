"""G2.2 — the hasher of the Git server client secret (django-oauth-toolkit keeps only its hash in the database).

The secret is random: the bundle generates 48 hex digits (192 bits) and ``ppm_oidc_client --ensure`` refuses anything
shorter than 32 hex digits (128 bits). Guessing such a secret is infeasible with any hash, so a slow password KDF
protects nothing here, while token/ would pay for it on every request: Django's PBKDF2 (1 000 000 iterations) costs
≈0.3 s of CPU per check — and anybody can make PPM pay it at will with a made-up secret. A salted HMAC-SHA256 costs
microseconds and still leaves a database dump without the secret.

Django's own hashers stay first in ``PASSWORD_HASHERS``: people's passwords keep PBKDF2 (this hasher is appended after
them and is used only where ``OAUTH2_PROVIDER["CLIENT_SECRET_HASHER"]`` names it). A client hashed earlier with PBKDF2
still verifies; ``ppm_oidc_client --ensure`` rewrites it with this hasher. Standard library and Django only — it is
loaded with ``PASSWORD_HASHERS`` also where django-oauth-toolkit is not installed.
"""

import hashlib
import hmac

from django.contrib.auth.hashers import BasePasswordHasher, mask_hash
from django.utils.crypto import constant_time_compare
from django.utils.translation import gettext_noop as _


class ClientSecretHasher(BasePasswordHasher):
    algorithm = "ppm_oidc_hmac_sha256"

    def encode(self, password, salt):
        self._check_encode_args(password, salt)
        digest = hmac.new(salt.encode("utf-8"), password.encode("utf-8"), hashlib.sha256).hexdigest()
        return f"{self.algorithm}${salt}${digest}"

    def decode(self, encoded):
        algorithm, salt, digest = encoded.split("$", 2)
        if algorithm != self.algorithm:
            raise ValueError("Not a hash of the Git server client secret")
        return {"algorithm": algorithm, "hash": digest, "salt": salt}

    def verify(self, password, encoded):
        try:
            decoded = self.decode(encoded)
        except ValueError:
            return False
        return constant_time_compare(encoded, self.encode(password, decoded["salt"]))

    def safe_summary(self, encoded):
        decoded = self.decode(encoded)
        return {
            _("algorithm"): decoded["algorithm"],
            _("salt"): mask_hash(decoded["salt"], show=2),
            _("hash"): mask_hash(decoded["hash"]),
        }

    def must_update(self, encoded):
        return False

    def harden_runtime(self, password, encoded):
        # Nothing to equalise: the cost of this hasher is negligible.
        pass
