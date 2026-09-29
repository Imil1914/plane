"""G2.2 R5 — a person switched off in PPM loses the codes and tokens issued to the Git server.

Bulk updates (``.update(is_active=False)``) send no signal: for them the validator refuses the person's tokens anyway
(``user_may_sign_in``), and the daily task removes them once expired. On the Git server itself the access module of
line S2 sets ``prohibit_login``.
"""

import logging

from django.db import DatabaseError, transaction

from plane.ppm_oidc import state

logger = logging.getLogger("plane.api")


def revoke_git_server_tokens(sender, instance, created=False, **kwargs):
    if created or state.user_may_sign_in(instance):
        return
    # With single sign-on off the endpoints answer 404 and the OAuth2 tables may even be missing (a deploy window
    # before `migrate`): nothing to do, and a user save must never fail because of this handler.
    if not state.sso_switch_is_on():
        return
    delete_git_server_tokens(instance.pk)


def delete_git_server_tokens(user_id):
    from oauth2_provider.models import (
        get_access_token_model,
        get_grant_model,
        get_id_token_model,
        get_refresh_token_model,
    )

    try:
        with transaction.atomic():
            for model in (get_grant_model(), get_refresh_token_model(), get_access_token_model(), get_id_token_model()):
                model.objects.filter(user_id=user_id).delete()
    except DatabaseError as exc:
        logger.warning(
            "Git server tokens of a switched-off user were not deleted",
            extra={"user_id": str(user_id), "error_class": type(exc).__name__},
        )
