import os
from urllib.parse import unquote, urlparse
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
    # docker-compose is what actually consumes POSTGRES_PASSWORD. It is declared
    # here only so the two values can be checked against each other below.
    postgres_password: str = ""

settings = Settings()


def _password_mismatch(s: Settings) -> bool:
    """True when POSTGRES_PASSWORD and DATABASE_URL disagree about the password.

    Both come from the same .env and describe the same account. The value inside
    the URL is percent-encoded while the compose one is a literal, so decode
    before comparing or an escaped password reads as a mismatch.
    """
    if not s.postgres_password:
        return False
    try:
        url_password = urlparse(s.database_url).password
    except ValueError:
        # An unparseable URL is the database layer's problem to report, not ours.
        return False
    if url_password is None:
        return False
    return unquote(url_password) != s.postgres_password


# Warn rather than fail. Postgres applies POSTGRES_PASSWORD only when its data
# volume is first created, so an existing volume whose password was rotated with
# ALTER USER sits in this state legitimately. It still matters: POSTGRES_PASSWORD
# is what a recreated volume would be initialised with, and the app would then be
# unable to connect with the DATABASE_URL it has.
if _password_mismatch(settings):
    print(
        "WARNING: POSTGRES_PASSWORD does not match the password in DATABASE_URL. "
        "Harmless while the current postgres_data volume exists, but a recreated "
        "volume would be initialised with POSTGRES_PASSWORD and the app would not "
        "be able to connect."
    )
