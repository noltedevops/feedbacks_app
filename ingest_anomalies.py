import os
import sys
import uuid
import logging
import pandas as pd
from sqlalchemy import create_engine, text

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("ingest_anomalies")

def load_env():
    """Manually load environment variables from .env file if it exists."""
    if os.path.exists(".env"):
        logger.info("Loading environment variables from .env file...")
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip()

def get_database_url():
    """Retrieve database connection URL, prioritizing environment variables."""
    load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL environment variable is not set.")
        sys.exit(1)
        
    # Map driver name for compatibility with SQLAlchemy 2
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    elif db_url.startswith("postgresql+psycopg2://"):
        db_url = db_url.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)
    return db_url

def find_file(choices):
    """Find the first available file from a list of choices."""
    for choice in choices:
        if os.path.exists(choice):
            return choice
    return None

def read_csv_robustly(filepath, default_sep=';'):
    """
    Read a CSV file using a default separator, with an automatic fallback 
    to comma if the default separator results in a single parsed column.
    """
    logger.info(f"Loading dataset from: {filepath}")
    df = pd.read_csv(filepath, sep=default_sep)
    
    # If single column parsed, fall back to comma
    if df.shape[1] <= 1:
        logger.info(f"Detected potential separator mismatch with '{default_sep}'. Retrying with ','...")
        df = pd.read_csv(filepath, sep=',')
        
    # Strip whitespace from column headers
    df.columns = df.columns.str.strip()
    return df

def main():
    # 1. READ SOURCE DATASETS INDEPENDENTLY
    georadar_path = find_file(["georadar.csv", "Radar_data.csv"])
    magnetic_path = find_file(["magnetic.csv", "Magnetic_data.csv"])
    
    if not georadar_path:
        logger.error("Georadar dataset not found (searched for georadar.csv, Radar_data.csv).")
        sys.exit(1)
    if not magnetic_path:
        logger.error("Magnetic dataset not found (searched for magnetic.csv, Magnetic_data.csv).")
        sys.exit(1)
        
    df_gpr = read_csv_robustly(georadar_path, default_sep=';')
    df_mag = read_csv_robustly(magnetic_path, default_sep=';')

    # 2. INJECT DISCRIMINATOR FIELDS & STRUCTURE ALIGNMENT
    logger.info("Aligning structures and generating discriminator fields...")
    df_gpr['instrument'] = 'georadar'
    df_mag['instrument'] = 'magnetic'

    # 3. CONSOLIDATE DATASETS
    logger.info("Consolidating datasets...")
    df_all = pd.concat([df_gpr, df_mag], ignore_index=True)
    
    # Map standard columns
    columns_map = {
        'Rechtswert': 'easting',
        'Hochwert': 'northing',
        'Tiefe [m]': 'evaluated_depth',
        'layer': 'layer'
    }
    df_all = df_all.rename(columns=columns_map)
    
    # Clean: Drop rows missing easting or northing coordinates
    initial_rows = len(df_all)
    df_all = df_all.dropna(subset=['easting', 'northing'])
    logger.info(f"Dropped {initial_rows - len(df_all)} rows due to missing coordinate fields.")
    
    # Correct coordinate offset for the 'Stoerkoerper Magnetik Sued 2' layer or where easting < 100000
    # Easting is missing a leading 4 (e.g. 46567 instead of 446567) and Northing has a 5 instead of a 3 (e.g. 5956640 instead of 5935640)
    sued2_mask = (df_all['layer'] == 'Stoerkoerper Magnetik Sued 2') | (df_all['easting'] < 100000.0)
    if sued2_mask.any():
        logger.info(f"Applying coordinate offset correction to {sued2_mask.sum()} points in 'Stoerkoerper Magnetik Sued 2'...")
        df_all.loc[sued2_mask, 'easting'] += 397000.0
        df_all.loc[sued2_mask, 'northing'] -= 21000.0
        
    # Drop rows with duplicate coordinates to ensure unique target_id
    before_dedup = len(df_all)
    df_all = df_all.drop_duplicates(subset=['easting', 'northing'])
    logger.info(f"Dropped {before_dedup - len(df_all)} rows with duplicate coordinates.")
    
    # Populate the required ERD and helper columns
    df_all['project_id'] = '11-24-2736'
    df_all['status'] = 'pending'
    df_all['category'] = 'Kat-1'
    df_all['target_id'] = df_all.apply(lambda row: f"11-24-2736-{row['easting']:.3f}-{row['northing']:.3f}", axis=1)
    df_all['vm_nr'] = [f"2736-{i+1}" for i in range(len(df_all))]
    
    # Generate unique stable 36-character string UUIDs based on target_id
    df_all['id'] = df_all['target_id'].apply(lambda tid: str(uuid.uuid5(uuid.NAMESPACE_DNS, tid)))
    
    # 4. TRANSLATE 2D GEOSPATIAL PARAMETERS
    logger.info("Translating coordinates to 2D WKT Points...")
    df_all['wkt_geom'] = df_all.apply(lambda row: f"POINT({row['easting']} {row['northing']})", axis=1)

    # Select only target columns for the staging table
    required_cols = ['id', 'project_id', 'instrument', 'easting', 'northing', 'evaluated_depth', 'layer', 'category', 'status', 'vm_nr', 'target_id', 'wkt_geom']
    df_staging = df_all[[c for c in required_cols if c in df_all.columns]].copy()

    # 5. BULK INGEST INTO POSTGRESQL
    db_url = get_database_url()
    logger.info("Connecting to database...")
    engine = create_engine(db_url)
    
    # SQL DDL/DML statements
    create_projects_table_sql = """
    CREATE TABLE IF NOT EXISTS public.projects (
        project_id VARCHAR(50) PRIMARY KEY,
        project_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """

    create_anomalies_table_sql = """
    CREATE TABLE IF NOT EXISTS public.anomalies (
        id VARCHAR(36) PRIMARY KEY,
        project_id VARCHAR(50) NOT NULL REFERENCES public.projects(project_id) ON DELETE CASCADE,
        instrument VARCHAR(50) NOT NULL,
        geom GEOMETRY(Point, 32632),
        easting DOUBLE PRECISION NOT NULL,
        northing DOUBLE PRECISION NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        vm_nr VARCHAR(50),
        category VARCHAR(50) DEFAULT 'Kat-1',
        layer VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        target_id VARCHAR(100) UNIQUE,
        evaluated_depth DOUBLE PRECISION
    );
    """
    
    insert_sql = """
    INSERT INTO public.anomalies (id, project_id, instrument, easting, northing, category, layer, status, vm_nr, target_id, evaluated_depth, geom)
    SELECT 
        id, 
        project_id, 
        instrument, 
        easting, 
        northing, 
        category, 
        layer, 
        status, 
        vm_nr, 
        target_id,
        evaluated_depth,
        ST_GeomFromText(wkt_geom, 32632)
    FROM temp_staging_anomalies;
    """

    with engine.begin() as conn:
        logger.info("Enabling PostGIS extension...")
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis;"))
        
        logger.info("Rebuilding anomalies, feedback, and projects tables to match ERD...")
        conn.execute(text("DROP TABLE IF EXISTS public.feedback CASCADE;"))
        conn.execute(text("DROP TABLE IF EXISTS public.anomalies CASCADE;"))
        conn.execute(text("DROP TABLE IF EXISTS public.projects CASCADE;"))
        
    # Recreate tables and initialize triggers properly
    from database import init_db
    init_db()
        
    insert_sql = """
    INSERT INTO public.anomalies (id, project_id, instrument, easting, northing, category, layer, status, vm_nr, target_id, evaluated_depth, geom)
    SELECT 
        id, 
        project_id, 
        instrument, 
        easting, 
        northing, 
        category, 
        layer, 
        status, 
        vm_nr, 
        target_id,
        evaluated_depth,
        ST_GeomFromText(wkt_geom, 32632)
    FROM temp_staging_anomalies;
    """

    with engine.begin() as conn:
        # Seed the project record
        logger.info("Seeding project '11-24-2736'...")
        conn.execute(
            text("INSERT INTO public.projects (project_id, project_name) VALUES (:pid, :name) ON CONFLICT DO NOTHING;"),
            {"pid": "11-24-2736", "name": "Wilhemshaven Rüstersieler Seedeich"}
        )
        
        # Stage unified DataFrame in temp table
        logger.info("Staging data in temp_staging_anomalies table...")
        df_staging.to_sql("temp_staging_anomalies", con=conn, if_exists="replace", index=False)
        
        # Ingest to final PostGIS table
        logger.info("Ingesting staged records into public.anomalies table...")
        conn.execute(text(insert_sql))
        
        # Drop staging table
        logger.info("Cleaning up temporary staging table...")
        conn.execute(text("DROP TABLE IF EXISTS temp_staging_anomalies;"))
        
    logger.info("DATABASE INGESTION COMPLETED SUCCESSFULLY!")
    
    # Display ingestion statistics
    gpr_count = len(df_staging[df_staging['instrument'] == 'georadar'])
    mag_count = len(df_staging[df_staging['instrument'] == 'magnetic'])
    logger.info(f"Ingested {gpr_count} georadar anomalies and {mag_count} magnetic anomalies (Total: {len(df_staging)}).")

if __name__ == "__main__":
    main()
