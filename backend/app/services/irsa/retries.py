"""One retry boundary for idempotent upstream reads; no framework dependencies."""
import random
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx
import requests
from pyvo.dal.exceptions import DALServiceError
from app.domain.errors import AppError

RETRY_STATUSES = {429, 502, 503, 504}


def retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0, float(value))
    except ValueError:
        try:
            return max(0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (ValueError, TypeError, OverflowError):
            return None


def read_with_retries(operation, *, attempts=3, deadline=90.0,
                      sleep=time.sleep, clock=time.monotonic, jitter=random.random):
    end = clock() + deadline
    for attempt in range(attempts):
        remaining = end - clock()
        if remaining <= 0:
            raise AppError("ARCHIVE_TIMEOUT", "The archive request timed out.", 504, True)
        try:
            return operation(remaining)
        except (httpx.HTTPError, requests.RequestException, DALServiceError) as exc:
            if isinstance(exc, DALServiceError):
                cause = getattr(exc, "cause", None)
                if isinstance(cause, (httpx.HTTPError, requests.RequestException)):
                    exc = cause
            if isinstance(exc, httpx.PoolTimeout):
                raise AppError("CUTOUT_CAPACITY_REACHED", "The server's archive connection pool is busy.",
                               503, True, 1) from exc
            response = getattr(exc, "response", None)
            status = response.status_code if response is not None else getattr(exc, "code", None)
            timeout = isinstance(exc, (httpx.TimeoutException, requests.Timeout))
            transient = status in RETRY_STATUSES or isinstance(exc, (
                httpx.TransportError, requests.ConnectionError, requests.Timeout,
                requests.exceptions.ChunkedEncodingError))
            wait = retry_after(response.headers.get("Retry-After")) if response is not None else None
            error = AppError(
                "ARCHIVE_TIMEOUT" if timeout or status == 504 else "ARCHIVE_UNAVAILABLE" if transient else "ARCHIVE_ERROR",
                "The archive request timed out." if timeout or status == 504 else "The archive is temporarily unavailable." if transient else "The archive rejected the request.",
                504 if timeout or status == 504 else 503 if transient else 502,
                transient, max(1, int(wait + 0.999)) if wait is not None else (5 if transient else None))
            delay = wait if wait is not None else 2 ** attempt + jitter()
            if not transient or attempt == attempts - 1 or delay >= end - clock():
                raise error from exc
            sleep(delay)
