import logging
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from app.domain.errors import AppError


def register_exception_handlers(app: FastAPI):
    @app.exception_handler(AppError)
    async def application_error(request: Request, exc: AppError):
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else {}
        return JSONResponse({"error": exc.payload()}, status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError):
        # Do not echo arbitrary inputs (including non-finite JSON values).
        fields = ", ".join(".".join(map(str, e["loc"])) for e in exc.errors())
        error = AppError("VALIDATION_ERROR", f"Invalid request fields: {fields}", 422)
        return JSONResponse({"error": error.payload()}, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        logging.getLogger(__name__).error("Unhandled API error", exc_info=exc)
        error = AppError("INTERNAL_ERROR", "The request could not be completed.", 500)
        return JSONResponse({"error": error.payload()}, status_code=500)
