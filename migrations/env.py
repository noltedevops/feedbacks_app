"""Alembic environment: the app's own engine and models, so a migration always runs against
the database DATABASE_URL names - the same one the server uses."""
from alembic import context

from database import engine
from models import Base

target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    """Autogenerate compares only what models.py defines. PostGIS's spatial_ref_sys, the
    ETL's schemas and the project schemas exist in the database but are not ours."""
    return not (type_ == "table" and reflected and compare_to is None)


def run(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata,
                      include_object=include_object)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("Offline (--sql) mode is not supported: migrations run against the database.")

with engine.connect() as connection:
    run(connection)
