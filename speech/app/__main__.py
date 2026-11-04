"""`python -m app` — runs the service with access logs off."""

import os

import uvicorn

uvicorn.run(
    "app.main:app",
    host=os.environ.get("HOST", "0.0.0.0"),
    port=int(os.environ.get("PORT", "8090")),
    access_log=False,
    log_level="warning",
)
