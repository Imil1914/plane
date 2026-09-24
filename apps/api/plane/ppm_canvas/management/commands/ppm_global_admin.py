from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from plane.db.models import User
from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminRoleAudit


class Command(BaseCommand):
    help = "List, grant, or revoke the protected PPM global administrator role."

    def add_arguments(self, parser):
        parser.add_argument("action", choices=("list", "grant", "revoke"))
        parser.add_argument("--email")
        parser.add_argument("--actor-email")
        parser.add_argument("--reason")
        parser.add_argument("--bootstrap", action="store_true")

    def handle(self, *args, **options):
        action = options["action"]
        if action == "list":
            self._list()
            return

        email = (options.get("email") or "").strip().lower()
        reason = (options.get("reason") or "").strip()
        if not email or not reason:
            raise CommandError("--email and --reason are required for grant/revoke.")

        actor = self._resolve_actor(options.get("actor_email"), bootstrap=options.get("bootstrap", False))
        target = User.objects.filter(email__iexact=email, is_active=True).first()
        if target is None:
            raise CommandError("Active user with this email was not found.")

        if action == "grant":
            self._grant(target=target, actor=actor, reason=reason)
        else:
            self._revoke(target=target, actor=actor, reason=reason)

    def _resolve_actor(self, actor_email, *, bootstrap):
        active_admins = PpmGlobalAdmin.objects.filter(revoked_at__isnull=True)
        if not active_admins.exists():
            if not bootstrap:
                raise CommandError("The first global administrator requires --bootstrap.")
            if actor_email:
                raise CommandError("--actor-email is not used during first bootstrap.")
            return None

        if bootstrap:
            raise CommandError("--bootstrap is only allowed when no active global administrator exists.")
        actor_email = (actor_email or "").strip().lower()
        if not actor_email:
            raise CommandError("--actor-email must identify an active global administrator.")
        actor_record = active_admins.select_related("user").filter(user__email__iexact=actor_email).first()
        if actor_record is None:
            raise CommandError("Actor is not an active global administrator.")
        return actor_record.user

    @transaction.atomic
    def _grant(self, *, target, actor, reason):
        record = PpmGlobalAdmin.objects.select_for_update().filter(user=target).first()
        if record and record.revoked_at is None:
            self.stdout.write(f"{target.email} is already an active global administrator.")
            return
        if record:
            record.reason = reason
            record.created_by = actor.id if actor else None
            record.created_at = timezone.now()
            record.revoked_at = None
            record.revoked_by = None
            record.save(update_fields=["reason", "created_by", "created_at", "revoked_at", "revoked_by"])
        else:
            PpmGlobalAdmin.objects.create(
                user=target,
                reason=reason,
                created_by=actor.id if actor else None,
            )
        PpmGlobalAdminRoleAudit.objects.create(
            target_user=target,
            actor_user=actor,
            action=PpmGlobalAdminRoleAudit.Action.GRANT,
            reason=reason,
        )
        self.stdout.write(self.style.SUCCESS(f"Granted protected global administrator role to {target.email}."))

    @transaction.atomic
    def _revoke(self, *, target, actor, reason):
        record = PpmGlobalAdmin.objects.select_for_update().filter(user=target, revoked_at__isnull=True).first()
        if record is None:
            raise CommandError("Target is not an active global administrator.")
        if PpmGlobalAdmin.objects.select_for_update().filter(revoked_at__isnull=True).count() <= 1:
            raise CommandError("The last active global administrator cannot be revoked.")
        record.revoked_at = timezone.now()
        record.revoked_by = actor.id if actor else None
        record.reason = reason
        record.save(update_fields=["revoked_at", "revoked_by", "reason"])
        PpmGlobalAdminRoleAudit.objects.create(
            target_user=target,
            actor_user=actor,
            action=PpmGlobalAdminRoleAudit.Action.REVOKE,
            reason=reason,
        )
        self.stdout.write(self.style.SUCCESS(f"Revoked protected global administrator role from {target.email}."))

    def _list(self):
        records = PpmGlobalAdmin.objects.select_related("user").order_by("user__email")
        for record in records:
            state = "active" if record.revoked_at is None else "revoked"
            self.stdout.write(f"{record.user.email}\t{state}\t{record.reason}")
