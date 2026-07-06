import logging
import math
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from config import settings
from models import Base

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("database")

db_url = settings.database_url
if db_url.startswith("postgresql://"):
    db_url = db_url.replace("postgresql://", "postgresql+psycopg://", 1)
elif db_url.startswith("postgresql+psycopg2://"):
    db_url = db_url.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)

engine = None

try:
    logger.info(f"Attempting to connect to database (mapped URL: {db_url})")
    if db_url.startswith("postgresql"):
        engine = create_engine(db_url, connect_args={"connect_timeout": 5})
        with engine.connect() as conn:
            logger.info("Successfully connected to PostgreSQL database.")
    else:
        engine = create_engine(db_url, connect_args={"check_same_thread": False})
        logger.info("Connected to SQLite database.")
except Exception as e:
    logger.error(f"Failed to connect to database URL {db_url}. Error: {e}")
    fallback_url = "sqlite:///./uxo_local.db"
    logger.warning(f"Falling back to local SQLite database at: {fallback_url}")
    engine = create_engine(fallback_url, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    logger.info("Initializing database tables...")
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables initialized successfully.")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Coordinate Conversion: UTM Zone 32N (EPSG:32632) to WGS84 Lat/Lng
def utm32n_to_latlon(easting: float, northing: float):
    # WGS84 Ellipsoid
    a = 6378137.0
    f = 1.0 / 298.257223563
    b = a * (1.0 - f)
    
    e2 = (a**2 - b**2) / a**2
    ep2 = (a**2 - b**2) / b**2
    
    k0 = 0.9996
    lon0 = 9.0 * math.pi / 180.0 # Central Meridian for Zone 32 (9 degrees East)
    
    x = easting - 500000.0
    y = northing
    
    # Footprint latitude calculation (Divide northing by scale factor k0 to get meridian distance M)
    M = y / k0
    mu = M / (a * (1.0 - e2/4.0 - 3.0*e2**2/64.0 - 5.0*e2**3/256.0))
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))
    
    foot_lat = (mu + (3.0*e1/2.0 - 27.0*e1**3/32.0)*math.sin(2.0*mu)
                + (21.0*e1**2/16.0 - 55.0*e1**4/32.0)*math.sin(4.0*mu)
                + (151.0*e1**3/96.0)*math.sin(6.0*mu)
                + (1097.0*e1**4/512.0)*math.sin(8.0*mu))
    
    sin_foot = math.sin(foot_lat)
    cos_foot = math.cos(foot_lat)
    tan_foot = math.tan(foot_lat)
    
    N1 = a / math.sqrt(1.0 - e2 * sin_foot**2)
    R1 = a * (1.0 - e2) / (1.0 - e2 * sin_foot**2)**1.5
    D_val = x / (N1 * k0)
    
    lat = (foot_lat - (N1 * tan_foot / R1) * (D_val**2/2.0 
           - (5.0 + 3.0*tan_foot**2 + 10.0*ep2*cos_foot**2 - 4.0*(ep2*cos_foot**2)**2 - 9.0*ep2)*D_val**4/24.0
           + (61.0 + 90.0*tan_foot**2 + 298.0*ep2*cos_foot**2 + 45.0*tan_foot**4 - 252.0*ep2 - 3.0*(ep2*cos_foot**2)**2)*D_val**6/720.0))
           
    lon = (lon0 + (D_val - (1.0 + 2.0*tan_foot**2 + ep2*cos_foot**2)*D_val**3/6.0
           + (5.0 - 2.0*ep2*cos_foot**2 + 28.0*tan_foot**2 - 3.0*(ep2*cos_foot**2)**2 + 8.0*ep2 + 24.0*tan_foot**4)*D_val**5/120.0) / cos_foot)
           
    return lat * 180.0 / math.pi, lon * 180.0 / math.pi

# Coordinate Conversion: WGS84 Lat/Lng to UTM Zone 32N (EPSG:32632)
def latlon_to_utm32n(lat: float, lon: float):
    a = 6378137.0
    f = 1.0 / 298.257223563
    b = a * (1.0 - f)
    
    e2 = (a**2 - b**2) / a**2
    ep2 = (a**2 - b**2) / b**2
    
    k0 = 0.9996
    lon0 = 9.0 * math.pi / 180.0
    
    lat_rad = lat * math.pi / 180.0
    lon_rad = lon * math.pi / 180.0
    
    N = a / math.sqrt(1.0 - e2 * math.sin(lat_rad)**2)
    T = math.tan(lat_rad)**2
    C = ep2 * math.cos(lat_rad)**2
    A = (lon_rad - lon0) * math.cos(lat_rad)
    
    M = a * (
        (1.0 - e2/4.0 - 3.0*e2**2/64.0 - 5.0*e2**3/256.0) * lat_rad
        - (3.0*e2/8.0 + 3.0*e2**2/32.0 + 45.0*e2**3/1024.0) * math.sin(2.0*lat_rad)
        + (15.0*e2**2/256.0 + 45.0*e2**3/1024.0) * math.sin(4.0*lat_rad)
        - (35.0*e2**3/3072.0) * math.sin(6.0*lat_rad)
    )
    
    x = k0 * N * (
        A + (1.0 - T + C) * A**3 / 6.0
        + (5.0 - 18.0*T + T**2 + 72.0*C - 58.0*ep2) * A**5 / 120.0
    ) + 500000.0
    
    y = k0 * (
        M + N * math.tan(lat_rad) * (
            A**2 / 2.0
            + (5.0 - T + 9.0*C + 4.0*C**2) * A**4 / 24.0
            + (61.0 - 58.0*T + T**2 + 600.0*C - 330.0*ep2) * A**6 / 720.0
        )
    )
    
    return x, y

