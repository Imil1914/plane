"""Read-only dependency checks before exposing a PPM backend deployment."""

import asyncio
import json
import os
import uuid

import boto3
import redis
from asgiref.sync import async_to_sync
from botocore.config import Config
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from plane.celery import app as celery_app


def check_database():
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
        if cursor.fetchone() != (1,):
            raise RuntimeError("Database probe returned an unexpected result")


def check_redis():
    if not settings.REDIS_URL:
        raise RuntimeError("Redis is not configured")
    client = redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=3, socket_timeout=3)
    try:
        if client.ping() is not True:
            raise RuntimeError("Redis did not respond")
    finally:
        client.close()


def check_broker():
    with celery_app.connection_for_read(connect_timeout=3) as broker:
        broker.connect()


def _object_storage_client():
    return boto3.client(
        "s3",
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        aws_session_token=os.environ.get("AWS_SESSION_TOKEN"),
        region_name=settings.AWS_REGION or None,
        endpoint_url=settings.AWS_S3_ENDPOINT_URL,
        config=Config(connect_timeout=3, read_timeout=3, retries={"max_attempts": 1}),
    )


def check_object_storage():
    client = _object_storage_client()
    client.head_bucket(Bucket=settings.AWS_STORAGE_BUCKET_NAME)


def check_object_storage_io():
    """Verify backend S3 access using a unique, short-lived probe object."""
    client = _object_storage_client()
    bucket = settings.AWS_STORAGE_BUCKET_NAME
    key = f"_ppm-preflight/{uuid.uuid4().hex}.bin"
    expected = uuid.uuid4().bytes
    put_result = client.put_object(Bucket=bucket, Key=key, Body=expected)
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        body = response["Body"]
        try:
            if body.read() != expected:
                raise RuntimeError("Object storage probe content did not round-trip")
        finally:
            body.close()
    finally:
        delete_args = {"Bucket": bucket, "Key": key}
        if version_id := put_result.get("VersionId"):
            delete_args["VersionId"] = version_id
        client.delete_object(**delete_args)


async def _probe_realtime():
    layer = get_channel_layer()
    if layer is None:
        raise RuntimeError("Realtime channel layer is unavailable")
    channel = await layer.new_channel("ppm.preflight")
    marker = uuid.uuid4().hex
    await layer.send(channel, {"type": "ppm.preflight", "marker": marker})
    message = await asyncio.wait_for(layer.receive(channel), timeout=3)
    if message.get("marker") != marker:
        raise RuntimeError("Realtime channel probe did not round-trip")


def check_realtime():
    backend = settings.CHANNEL_LAYERS.get("default", {}).get("BACKEND")
    if backend != "channels_redis.core.RedisChannelLayer":
        raise RuntimeError("Realtime must use a shared Redis channel layer")
    async_to_sync(_probe_realtime)()


class Command(BaseCommand):
    help = "Check PPM backend dependencies without exposing credentials or changing project data."

    def add_arguments(self, parser):
        parser.add_argument(
            "--verify-storage-write",
            action="store_true",
            help="Write, read and delete a temporary object in the configured upload bucket.",
        )

    def handle(self, *args, **options):
        checks = (
            ("database", check_database),
            ("redis", check_redis),
            ("broker", check_broker),
            ("object_storage", check_object_storage),
            ("realtime", check_realtime),
        )
        if options["verify_storage_write"]:
            checks += (("object_storage_io", check_object_storage_io),)
        results = {}
        for name, check in checks:
            try:
                check()
            except Exception:
                # Provider exceptions can contain hostnames and credentials. Report only
                # the failed component; operators can inspect restricted service logs.
                results[name] = "fail"
            else:
                results[name] = "ok"

        failed = [name for name, result in results.items() if result == "fail"]
        self.stdout.write(json.dumps({"status": "fail" if failed else "ok", "checks": results}, sort_keys=True))
        if failed:
            raise CommandError(f"PPM backend preflight failed: {', '.join(failed)}")
