import os
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # .env is shared with docker-compose, which reads POSTGRES_* and PGADMIN_* from
    # the same file. Without extra="ignore", pydantic rejects every key it does not
    # recognise and the app refuses to start over settings that are not its own.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/nolte_geoservices")
    host: str = "0.0.0.0"
    port: int = 8000
    # Signs session tokens. Leave unset for local work and a random one is used,
    # which logs everyone out on restart; set it in .env for anything shared.
    auth_secret: str = os.getenv("AUTH_SECRET", "")
    # Password given to the default accounts, and only when the users table is
    # seeded empty. Unset means each seeded account gets its own random one.
    seed_password: str = os.getenv("SEED_PASSWORD", "")

settings = Settings()
