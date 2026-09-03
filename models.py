from sqlalchemy import Column, String, Float, Boolean, DateTime, Integer, ForeignKey, JSON, create_engine, text
from sqlalchemy.orm import declarative_base, relationship
from geoalchemy2 import Geometry
import datetime
import uuid

Base = declarative_base()

class Project(Base):
    __tablename__ = "projects"

    project_id = Column(String(50), primary_key=True)
    project_name = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    anomalies = relationship("Anomaly", back_populates="project", cascade="all, delete-orphan")

class Anomaly(Base):
    __tablename__ = "anomalies"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(50), ForeignKey("projects.project_id", ondelete="CASCADE"), nullable=False)
    instrument = Column(String(50), nullable=False)
    geom = Column(Geometry(geometry_type='POINT', srid=32632), nullable=True)
    easting = Column(Float, nullable=False)
    northing = Column(Float, nullable=False)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    vm_nr = Column(String(50), nullable=True, index=True) # Hyphenated sequential target ID
    category = Column(String(50), nullable=True)
    layer = Column(String(255), nullable=True)
    status = Column(String(50), nullable=True, default='pending') # 'pending', 'investigated'
    target_id = Column(String(100), unique=True, index=True) # Unique ID combining project ID + coordinates

    # For GPR/excel seeding calculated parameters
    evaluated_depth = Column(Float, nullable=True)

    project = relationship("Project", back_populates="anomalies")
    feedbacks = relationship("Feedback", back_populates="anomaly", cascade="all, delete-orphan")

class Feedback(Base):
    __tablename__ = "feedback"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    anomaly_id = Column(String(36), ForeignKey("anomalies.id", ondelete="CASCADE"), nullable=False)
    # Which project this record belongs to. Reachable through anomaly_id already, so it
    # is strictly a denormalisation - it exists so feedback can be filtered and reported
    # on by project without joining anomalies every time. Written from the parent
    # anomaly's project_id, never from the client, so the two cannot disagree.
    #
    # Nullable: rows written before this column existed are backfilled on startup, and
    # until that has been confirmed clean everywhere a NULL has to be representable.
    project_id = Column(String(50), ForeignKey("projects.project_id", ondelete="CASCADE"), nullable=True, index=True)
    visited = Column(Boolean, default=True)
    visit_date = Column(DateTime, default=datetime.datetime.utcnow)
    tief = Column(Float, nullable=True)             # actual depth (Tiefe)
    laenge = Column(Float, nullable=True)           # length (Länge)
    breite = Column(Float, nullable=True)           # width (Breite)
    m_cube = Column(Float, nullable=True)           # volume (m³)
    fundstueck = Column(String(255), nullable=True) # description of findings
    investigator = Column(String(100), nullable=True)
    investigator_username = Column(String(100), nullable=True)
    photos = Column(String, nullable=True) # Serialized JSON array of base64 strings
    notes = Column(String, nullable=True)  # text remarks
    
    # New fields
    target_id = Column(String(100), index=True)
    sohle_status = Column(String(50), nullable=True)
    bilder_n = Column(Integer, nullable=True, default=0)
    other = Column(String(255), nullable=True)

    # Teams & tools captured on the field form:
    # {need_update, truppfuehrer, maschinenfuehrer, bez_suchfeld, messgeraet, sondierer}
    teams_tools = Column(JSON, nullable=True)

    anomaly = relationship("Anomaly", back_populates="feedbacks")

class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    full_name = Column(String(100), nullable=False)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), nullable=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(50), nullable=False, default="collector") # 'collector' or 'dashboard'
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Per-surface access. These - not role - decide what a user may open; role is
    # kept as the landing view and as the label shown in the sidebar.
    can_field = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    can_dashboard = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    is_admin = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    # Set when an admin issues a temporary password; the user cannot reach any
    # surface until they have chosen their own.
    must_change_password = Column(Boolean, nullable=False, default=False, server_default=text("false"))


class PermissionRequest(Base):
    """Raised when a user opens a surface they lack, decided by an admin."""
    __tablename__ = "permission_requests"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    surface = Column(String(20), nullable=False)          # 'field' or 'dashboard'
    status = Column(String(20), nullable=False, default="pending")  # pending/approved/denied
    message = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(String(36), nullable=True)        # users.id of the deciding admin

    user = relationship("User")

