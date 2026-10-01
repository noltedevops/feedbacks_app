"""The app: FastAPI instance, startup, the API routers and the built frontend.

Endpoints live in routers/, one module per area; authentication and the access
dependencies in security.py."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import assistant
from database import SessionLocal, init_db
from routers import admin, auth, etl, permissions, points, reports
from security import seed_default_users


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown, replacing the deprecated @app.on_event hooks.

    Everything before the yield runs once before the first request; anything
    after it would run on shutdown, of which this app has none.

    init_db() - schema DDL and triggers - runs here, when the server starts, and
    not at import: importing this module (tests, manage_access.py) used to apply
    it to whatever DATABASE_URL named, which by default is the live database.
    """
    init_db()
    db = SessionLocal()
    try:
        seed_default_users(db)
    finally:
        db.close()
    yield


app = FastAPI(
    title="Nolte Geoservices UXO Target Sync Platform",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for module in (auth, admin, permissions, points, reports, etl):
    app.include_router(module.router)


# The landing page's assistant. Registered before the static mount below, which
# answers every path that reaches it.
app.include_router(assistant.router)

# Next to this file, not the working directory: the server finds the frontend whatever
# folder it was started from.
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
else:
    @app.get("/")
    def read_root():
        return {"message": "Nolte Geoservices platform server running."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
