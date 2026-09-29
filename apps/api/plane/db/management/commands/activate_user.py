# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.core.management import BaseCommand, CommandError

# Module imports
from plane.db.models import User


class Command(BaseCommand):
    help = "Make the user with the given email active"

    def add_arguments(self, parser):
        # Positional argument
        parser.add_argument("email", type=str, help="user email")

    def handle(self, *args, **options):
        # get the user email from console
        email = options.get("email", False)

        # raise error if email is not present
        if not email:
            raise CommandError("Error: Email is required")

        # filter the user
        user = User.objects.filter(email=email).first()

        # Raise error if the user is not present
        if not user:
            raise CommandError(f"Error: User with {email} does not exists")

        # PPM G2.2 R15a: a person switched off in the PPM administration center is switched back on the way its
        # «Включить» does it — the mark goes first; while it is there, saving the person keeps them switched off.
        if not user.is_active:
            from plane.ppm_core.models import PpmUserSuspension
            from plane.ppm_core.suspension import resume_user

            if PpmUserSuspension.objects.filter(user=user).exists():
                resume_user(user.id)
                self.stdout.write(
                    self.style.SUCCESS("User activated successfully (was switched off in the PPM admin center)")
                )
                return

        # Activate the user
        user.is_active = True
        user.save()

        self.stdout.write(self.style.SUCCESS("User activated successfully"))
