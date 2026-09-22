from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import init_db
from app.routes import auth_routes, claims_routes, internal_routes, policies_routes


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="DICS Backend (Aurelia Labs)", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten before this runs anywhere beyond local dev
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_routes.router)
app.include_router(claims_routes.router)
app.include_router(internal_routes.router)
app.include_router(policies_routes.router)


@app.get("/health")
def health():
    return {"status": "ok"}
