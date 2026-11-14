class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 502,
                 retryable: bool = False, retry_after: int | None = None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
        self.retryable, self.retry_after = retryable, retry_after

    def payload(self) -> dict:
        return {"code": self.code, "message": self.message,
                "retryable": self.retryable, "retryAfterSeconds": self.retry_after}
