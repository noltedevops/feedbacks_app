from sqlalchemy import Column, String, Float, Boolean, DateTime, Integer, ForeignKey, create_engine
from sqlalchemy.orm import declarative_base, relationship
import datetime
import uuid

Base = declarative_base()

class Point(Base):
    __tablename__ = "points"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    vm_nr = Column(Integer, nullable=False, index=True)
    easting = Column(Float, nullable=False)
    northing = Column(Float, nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    calculated_depth = Column(Float, nullable=True) # GPR estimate in meters (Tiefe)
    
    # Opening geometry attributes (Öffnung)
    opening_length = Column(Float, nullable=True)   # Länge in meters
    opening_width = Column(Float, nullable=True)    # Breite in meters
    opening_depth = Column(Float, nullable=True)    # Tiefe in meters
    opening_volume = Column(Float, nullable=True)   # m³ volume
    
    find_description = Column(String(255), nullable=True) # Fundstück
    image_id = Column(Integer, nullable=True)             # Bild Nr.
    remarks = Column(String(255), nullable=True)          # Bemerkung
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    feedback_logs = relationship("FeedbackLog", back_populates="point", cascade="all, delete-orphan")

class FeedbackLog(Base):
    __tablename__ = "feedback"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    point_id = Column(String(36), ForeignKey("points.id", ondelete="CASCADE"), nullable=False)
    visited = Column(Boolean, default=True)
    status = Column(String(50), nullable=False) # 'clear', 'scrap', 'uxo', 'false_alarm' or custom 'other'
    actual_depth = Column(Float, nullable=True)
    photos = Column(String, nullable=True) # Serialized JSON array of base64 strings
    notes = Column(String, nullable=True)
    investigator = Column(String(100), nullable=True)
    investigator_username = Column(String(100), nullable=True)
    logged_at = Column(DateTime, default=datetime.datetime.utcnow)

    point = relationship("Point", back_populates="feedback_logs")
