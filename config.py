import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/nolte_geoservices")
    host: str = "0.0.0.0"
    port: int = 8000
    
    class Config:
        env_file = ".env"

settings = Settings()
