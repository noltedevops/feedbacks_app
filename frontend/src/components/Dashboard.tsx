import React, { useState } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { 
  Database, 
  Layers, 
  CheckCircle2, 
  Clock, 
  AlertOctagon, 
  Download, 
  ChevronLeft, 
  ChevronRight, 
  FileSpreadsheet, 
  FileText,
  X,
  FolderOpen
} from 'lucide-react';

interface DashboardProps {
  points: LocalPoint[];
  filteredPoints: LocalPoint[];
  selectedPoint: LocalPoint | null;
  onSelectPoint: (point: LocalPoint | null) => void;
  isOnline: boolean;
  onSeedRequest: () => Promise<void>;
  addDataOpen: boolean;
  setAddDataOpen: (open: boolean) => void;
  filterStatus: string;
  setFilterStatus: (status: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ 
  points, 
  filteredPoints,
  selectedPoint, 
  onSelectPoint, 
  isOnline,
  onSeedRequest,
  addDataOpen,
  setAddDataOpen,
  filterStatus,
  setFilterStatus
}) => {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [connectionType, setConnectionType] = useState<'folder' | 'csv' | 'shapefile' | 'database'>('csv');
  const [dbConnString, setDbConnString] = useState('');
  
  // Calculate statistics
  const total = points.length;
  const investigated = points.filter(p => p.local_status && p.local_status !== 'unvisited').length;
  const pending = total - investigated;
  const falseAlarms = points.filter(p => p.local_status === 'false_alarm').length;
  
  // Photo Carousel helpers
  const selectedPhotos = selectedPoint?.feedback?.photos || [];
  
  const handlePrevPhoto = () => {
    if (selectedPhotos.length === 0) return;
    setPhotoIndex(prev => (prev === 0 ? selectedPhotos.length - 1 : prev - 1));
  };
  
  const handleNextPhoto = () => {
    if (selectedPhotos.length === 0) return;
    setPhotoIndex(prev => (prev === selectedPhotos.length - 1 ? 0 : prev + 1));
  };

  // CSV Exporter for selected point report
  const downloadSingleCSV = () => {
    if (!selectedPoint) return;
    
    const status = selectedPoint.local_status || 'pending';
    const feedback = selectedPoint.feedback;
    
    const headers = [
      'VM Nr.', 'Easting (X)', 'Northing (Y)', 'Calculated Depth (m)', 
      'Find Description', 'Remarks', 'Status', 'Actual Depth (m)', 
      'Investigator', 'Logged At', 'Notes'
    ];
    
    const rows = [
      [
        selectedPoint.vm_nr,
        selectedPoint.easting,
        selectedPoint.northing,
        selectedPoint.calculated_depth || 'N/A',
        selectedPoint.find_description || 'N/A',
        selectedPoint.remarks || '---',
        status.toUpperCase(),
        feedback?.actual_depth || 'N/A',
        feedback?.investigator || 'N/A',
        feedback?.logged_at || 'N/A',
        feedback?.notes || ''
      ]
    ];
    
    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(','), ...rows.map(e => e.map(val => `"${val}"`).join(","))].join("\n");
      
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Target_VM_${selectedPoint.vm_nr}_Report.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // HTML Print / PDF Exporter
  const downloadSinglePDF = () => {
    if (!selectedPoint) return;
    
    const status = selectedPoint.local_status || 'pending';
    const feedback = selectedPoint.feedback;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`
      <html>
        <head>
          <title>Nolte Geoservices Platforms - Target Report VM-${selectedPoint.vm_nr}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #f97316; padding-bottom: 20px; margin-bottom: 30px; }
            .title { font-size: 24px; font-weight: bold; color: #1e293b; }
            .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; }
            .meta-item { border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; }
            .meta-label { font-size: 11px; color: #64748b; font-weight: bold; text-transform: uppercase; }
            .meta-value { font-size: 16px; margin-top: 4px; font-weight: bold; color: #0f172a; }
            .photos-section { margin-top: 30px; }
            .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
            .photo-card { border: 1px solid #e2e8f0; padding: 6px; border-radius: 6px; }
            .photo-card img { width: 100%; height: 150px; object-fit: cover; border-radius: 4px; }
            .footer { border-top: 1px solid #e2e8f0; margin-top: 50px; padding-top: 15px; font-size: 12px; color: #94a3b8; text-align: center; }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <div class="title">TARGET TRACKER FEEDBACK</div>
              <div style="font-size: 14px; color: #64748b; margin-top: 4px;">Nolte Geoservices Platforms GmbH | Field Operations</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 18px; font-weight: bold; color: #f97316;">VM Nr. ${selectedPoint.vm_nr}</div>
              <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Date Exported: ${new Date().toLocaleDateString()}</div>
            </div>
          </div>

          <div class="meta-grid">
            <div class="meta-item">
              <div class="meta-label">UTM Coordinates</div>
              <div class="meta-value">X: ${selectedPoint.easting} | Y: ${selectedPoint.northing}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Calculated Depth (m)</div>
              <div class="meta-value">${selectedPoint.calculated_depth ? `${selectedPoint.calculated_depth} m` : 'N/A'}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Original GPR Find</div>
              <div class="meta-value">${selectedPoint.find_description || 'N/A'}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Clearance Status</div>
              <div class="meta-value" style="color: ${status === 'pending' ? '#ef4444' : '#10b981'}">${status.toUpperCase()}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Actual dug depth (m)</div>
              <div class="meta-value">${feedback?.actual_depth ? `${feedback.actual_depth} m` : 'N/A'}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Investigator Name</div>
              <div class="meta-value">${feedback?.investigator || 'N/A'}</div>
            </div>
            <div class="meta-item" style="grid-column: 1 / -1;">
              <div class="meta-label">Additional Comments / Remarks</div>
              <div class="meta-value" style="font-weight: normal; font-size: 14px;">
                ${feedback?.notes || selectedPoint.remarks || 'No notes reported.'}
              </div>
            </div>
          </div>

          ${feedback?.photos && JSON.parse(JSON.stringify(feedback.photos)).length > 0 ? `
            <div class="photos-section">
              <div class="meta-label">Submitted Pictures</div>
              <div class="photo-grid">
                ${JSON.parse(JSON.stringify(feedback.photos)).map((img: string, idx: number) => `
                  <div class="photo-card">
                    <img src="${img}" alt="Attachment ${idx + 1}" />
                    <div style="font-size: 11px; color: #94a3b8; text-align: center; margin-top: 4px;">Photo ${idx + 1}</div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div class="footer">
            Confidential Geophysics Survey Document - Nolte Geoservices Platforms GmbH &copy; ${new Date().getFullYear()}
          </div>

          <script>
            window.onload = function() { window.print(); }
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // Base64 Single Photo Downloader
  const downloadActivePhoto = () => {
    if (selectedPhotos.length === 0) return;
    const link = document.createElement("a");
    link.href = selectedPhotos[photoIndex];
    link.download = `Target_${selectedPoint?.vm_nr}_Photo_${photoIndex + 1}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Handles Mock Data Import Submit
  const handleAddDataSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (connectionType === 'csv') {
      alert("Please upload a GPR CSV file inside the 'Load Points' section.");
      setAddDataOpen(false);
      return;
    }
    // Simulate database seeding if database is connected
    if (connectionType === 'database') {
      if (!dbConnString.trim()) {
        alert("Please enter database connection string.");
        return;
      }
      if (!isOnline) {
        alert("Must be online to connect to PostgreSQL database.");
        return;
      }
      onSeedRequest().then(() => {
        setAddDataOpen(false);
      });
      return;
    }
    alert("Connection established! Seeded demo survey grid successfully.");
    onSeedRequest().then(() => {
      setAddDataOpen(false);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '4px', height: '100%', overflow: 'hidden' }}>
      
      {/* Dashboard Section Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '12px' }}>
        <h2 style={{ fontSize: '1.1rem', color: '#f1f5f9', fontWeight: 700, margin: 0 }}>
          Clearance Analytics
        </h2>
      </div>

      {/* Analytics Widgets (Indicator Widgets) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
        
        {/* Widget 1: Total Targets */}
        <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', borderLeft: '4px solid #f97316', background: 'linear-gradient(135deg, rgba(31, 41, 55, 0.3) 0%, rgba(17, 24, 39, 0.4) 100%)' }}>
          <div style={{ backgroundColor: 'rgba(249, 115, 22, 0.12)', padding: '8px', borderRadius: 'var(--radius-sm)', color: '#f97316' }}>
            <Database size={20} />
          </div>
          <div>
            <div style={{ fontSize: '0.65rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.05em' }}>TOTAL TARGETS</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, fontFamily: 'var(--font-heading)', color: '#fff' }}>{total}</div>
          </div>
        </div>

        {/* Widget 2: Investigated */}
        <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', borderLeft: '4px solid #10b981', background: 'linear-gradient(135deg, rgba(31, 41, 55, 0.3) 0%, rgba(17, 24, 39, 0.4) 100%)' }}>
          <div style={{ backgroundColor: 'rgba(16, 185, 129, 0.12)', padding: '8px', borderRadius: 'var(--radius-sm)', color: '#10b981' }}>
            <CheckCircle2 size={20} />
          </div>
          <div>
            <div style={{ fontSize: '0.65rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.05em' }}>INVESTIGATED</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#10b981', fontFamily: 'var(--font-heading)' }}>{investigated}</div>
          </div>
        </div>

        {/* Widget 3: Pending */}
        <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', borderLeft: '4px solid #ef4444', background: 'linear-gradient(135deg, rgba(31, 41, 55, 0.3) 0%, rgba(17, 24, 39, 0.4) 100%)' }}>
          <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)', padding: '8px', borderRadius: 'var(--radius-sm)', color: '#ef4444' }}>
            <Clock size={20} />
          </div>
          <div>
            <div style={{ fontSize: '0.65rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.05em' }}>PENDING</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#ef4444', fontFamily: 'var(--font-heading)' }}>{pending}</div>
          </div>
        </div>

        {/* Widget 4: False Alarms */}
        <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', borderLeft: '4px solid #8b5cf6', background: 'linear-gradient(135deg, rgba(31, 41, 55, 0.3) 0%, rgba(17, 24, 39, 0.4) 100%)' }}>
          <div style={{ backgroundColor: 'rgba(139, 92, 246, 0.12)', padding: '8px', borderRadius: 'var(--radius-sm)', color: '#8b5cf6' }}>
            <AlertOctagon size={20} />
          </div>
          <div>
            <div style={{ fontSize: '0.65rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.05em' }}>FALSE ALARMS</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#a78bfa', fontFamily: 'var(--font-heading)' }}>{falseAlarms}</div>
          </div>
        </div>

      </div>

      {/* Target Points List (Green / Red colored display) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexGrow: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
            Target Points Clearance Log ({filteredPoints.length})
          </span>
          <select
            className="form-input"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ width: '130px', fontSize: '0.7rem', height: '24px', padding: '0 4px', background: 'rgba(17, 24, 39, 0.4)' }}
          >
            <option value="all">All Targets</option>
            <option value="investigated">Investigated</option>
            <option value="pending">Pending</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto', flexGrow: 1, paddingRight: '4px' }}>
          {filteredPoints.map((point) => {
            const isInvestigated = point.local_status && point.local_status !== 'unvisited';
            const color = isInvestigated ? '#10b981' : '#ef4444'; // Green for investigated, Red for pending

            return (
              <div
                key={point.id}
                className="glass-card"
                onClick={() => { onSelectPoint(point); setPhotoIndex(0); }}
                style={{
                  padding: '10px 14px',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  borderLeft: `4px solid ${color}`,
                  background: selectedPoint?.id === point.id ? 'rgba(255, 255, 255, 0.04)' : undefined
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#f8fafc' }}>VM Nr. {point.vm_nr}</span>
                    <span style={{ fontSize: '0.65rem', color: '#64748b', background: 'rgba(255,255,255,0.02)', padding: '1px 6px', borderRadius: '4px' }}>
                      {point.calculated_depth ? `Est: ${point.calculated_depth}m` : 'No Depth'}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '280px' }}>
                    Find: {point.find_description || 'N/A'}
                  </div>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    color: color,
                    textTransform: 'uppercase'
                  }}>
                    {isInvestigated ? 'Investigated' : 'Pending'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Target Details Drawer Panel (selectedPoint sidebar details) */}
      {selectedPoint && (
        <div className="details-drawer" style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: '360px',
          height: '100%',
          backgroundColor: 'rgba(11, 15, 25, 0.96)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
          zIndex: 1001,
          padding: '16px',
          boxShadow: '-10px 0 25px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          animation: 'slide-in-drawer 0.2s ease-out'
        }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '8px' }}>
            <h3 style={{ fontSize: '1.05rem', color: '#fff', margin: 0 }}>Target details</h3>
            <button onClick={() => onSelectPoint(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
              <X size={18} />
            </button>
          </div>

          <div style={{ flexGrow: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.8rem' }}>
            
            {/* Metadata Grid */}
            <div className="glass-card" style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
              <div style={{ fontWeight: 'bold', color: 'hsl(var(--primary))', fontSize: '0.9rem' }}>VM Nr. {selectedPoint.vm_nr}</div>
              <div><span style={{ color: '#64748b' }}>Coordinates:</span> <span style={{ color: '#cbd5e1' }}>X: {selectedPoint.easting} | Y: {selectedPoint.northing}</span></div>
              <div><span style={{ color: '#64748b' }}>GPR Est. Depth:</span> <span style={{ color: '#cbd5e1' }}>{selectedPoint.calculated_depth ? `${selectedPoint.calculated_depth} m` : 'N/A'}</span></div>
              <div><span style={{ color: '#64748b' }}>Baseline GPR Find:</span> <span style={{ color: '#cbd5e1' }}>{selectedPoint.find_description || 'N/A'}</span></div>
              <div><span style={{ color: '#64748b' }}>Opening Info:</span> <span style={{ color: '#cbd5e1' }}>{selectedPoint.opening_length}m x {selectedPoint.opening_width}m x {selectedPoint.opening_depth}m (Vol: {selectedPoint.opening_volume}m³)</span></div>
              <div><span style={{ color: '#64748b' }}>Baseline Remarks:</span> <span style={{ color: '#cbd5e1' }}>{selectedPoint.remarks || '---'}</span></div>
            </div>

            {/* Field Logged findings */}
            <div className="glass-card" style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', borderLeft: `3px solid ${selectedPoint.local_status !== 'unvisited' ? '#10b981' : '#ef4444'}` }}>
              <div style={{ fontWeight: 'bold', color: '#fff' }}>Field Log Feedback</div>
              <div>
                <span style={{ color: '#64748b' }}>Clearance State:</span>{' '}
                <span style={{ 
                  fontWeight: 'bold', 
                  color: selectedPoint.local_status !== 'unvisited' ? '#10b981' : '#ef4444' 
                }}>
                  {(selectedPoint.local_status || 'pending').toUpperCase()}
                </span>
              </div>
              
              {selectedPoint.feedback ? (
                <>
                  <div><span style={{ color: '#64748b' }}>Actual Dug Depth:</span> <span style={{ color: '#cbd5e1' }}>{selectedPoint.feedback.actual_depth ? `${selectedPoint.feedback.actual_depth} m` : 'N/A'}</span></div>
                  <div><span style={{ color: '#64748b' }}>Investigator Name:</span> <span style={{ color: '#cbd5e1' }}>{selectedPoint.feedback.investigator || 'N/A'}</span></div>
                  <div><span style={{ color: '#64748b' }}>Notes & Comments:</span> <span style={{ color: '#cbd5e1', display: 'block', marginTop: '2px', lineHeight: '1.4' }}>{selectedPoint.feedback.notes || 'No comments left.'}</span></div>
                  <div><span style={{ color: '#64748b' }}>Logged Timestamp:</span> <span style={{ color: '#cbd5e1' }}>{new Date(selectedPoint.feedback.logged_at).toLocaleString()}</span></div>
                </>
              ) : (
                <div style={{ color: '#64748b', fontSize: '0.75rem', fontStyle: 'italic', marginTop: '2px' }}>Target area has not been investigated yet.</div>
              )}
            </div>

            {/* Submitted Pictures Carousel */}
            {selectedPhotos.length > 0 && (
              <div className="glass-card" style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ color: '#64748b', fontWeight: 'bold' }}>Submitted Pictures ({selectedPhotos.length})</span>
                <div style={{ position: 'relative', width: '100%', height: '160px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <img src={selectedPhotos[photoIndex]} alt={`Survey Attachment ${photoIndex + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  
                  {/* Prev/Next buttons */}
                  {selectedPhotos.length > 1 && (
                    <>
                      <button
                        onClick={handlePrevPhoto}
                        style={{
                          position: 'absolute',
                          left: '6px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          backgroundColor: 'rgba(17, 24, 39, 0.8)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          color: '#fff',
                          borderRadius: '50%',
                          width: '24px',
                          height: '24px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer'
                        }}
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <button
                        onClick={handleNextPhoto}
                        style={{
                          position: 'absolute',
                          right: '6px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          backgroundColor: 'rgba(17, 24, 39, 0.8)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          color: '#fff',
                          borderRadius: '50%',
                          width: '24px',
                          height: '24px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer'
                        }}
                      >
                        <ChevronRight size={14} />
                      </button>
                    </>
                  )}

                  {/* Float Downloader button */}
                  <button
                    onClick={downloadActivePhoto}
                    style={{
                      position: 'absolute',
                      right: '6px',
                      bottom: '6px',
                      backgroundColor: 'rgba(17, 24, 39, 0.85)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      color: '#fff',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title="Download picture"
                  >
                    <Download size={12} />
                  </button>
                </div>
              </div>
            )}

          </div>

          {/* Action Downloads Footer */}
          <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px' }}>
            <button onClick={downloadSingleCSV} className="btn-secondary" style={{ flex: 1, padding: '8px 4px', fontSize: '0.75rem', gap: '4px' }}>
              <FileSpreadsheet size={14} /> Export CSV
            </button>
            <button onClick={downloadSinglePDF} className="btn-secondary" style={{ flex: 1, padding: '8px 4px', fontSize: '0.75rem', gap: '4px' }}>
              <FileText size={14} /> Print PDF
            </button>
          </div>

        </div>
      )}

      {/* Add Data Dialog Modal */}
      {addDataOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          backgroundColor: 'rgba(0, 0, 0, 0.75)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <div className="glass-panel" style={{
            width: '420px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            animation: 'scale-up 0.15s ease'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '10px' }}>
              <h3 style={{ fontSize: '1rem', color: '#fff', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Layers size={16} color="hsl(var(--primary))" /> Add GPR Survey Layer
              </h3>
              <button onClick={() => setAddDataOpen(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAddDataSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              
              {/* Connection Source switcher */}
              <div className="form-group">
                <label className="form-label">Connection Source</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={() => setConnectionType('csv')}
                    style={{
                      border: `1px solid ${connectionType === 'csv' ? 'hsl(var(--primary))' : 'rgba(255, 255, 255, 0.06)'}`,
                      background: connectionType === 'csv' ? 'rgba(249, 115, 22, 0.08)' : 'rgba(17, 24, 39, 0.2)',
                      padding: '8px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: connectionType === 'csv' ? '#f97316' : '#94a3b8'
                    }}
                  >
                    CSV File Importer
                  </button>
                  <button
                    type="button"
                    onClick={() => setConnectionType('folder')}
                    style={{
                      border: `1px solid ${connectionType === 'folder' ? 'hsl(var(--primary))' : 'rgba(255, 255, 255, 0.06)'}`,
                      background: connectionType === 'folder' ? 'rgba(249, 115, 22, 0.08)' : 'rgba(17, 24, 39, 0.2)',
                      padding: '8px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: connectionType === 'folder' ? '#f97316' : '#94a3b8'
                    }}
                  >
                    Local Folder Sync
                  </button>
                  <button
                    type="button"
                    onClick={() => setConnectionType('shapefile')}
                    style={{
                      border: `1px solid ${connectionType === 'shapefile' ? 'hsl(var(--primary))' : 'rgba(255, 255, 255, 0.06)'}`,
                      background: connectionType === 'shapefile' ? 'rgba(249, 115, 22, 0.08)' : 'rgba(17, 24, 39, 0.2)',
                      padding: '8px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: connectionType === 'shapefile' ? '#f97316' : '#94a3b8'
                    }}
                  >
                    Shapefiles (.shp)
                  </button>
                  <button
                    type="button"
                    onClick={() => setConnectionType('database')}
                    style={{
                      border: `1px solid ${connectionType === 'database' ? 'hsl(var(--primary))' : 'rgba(255, 255, 255, 0.06)'}`,
                      background: connectionType === 'database' ? 'rgba(249, 115, 22, 0.08)' : 'rgba(17, 24, 39, 0.2)',
                      padding: '8px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: connectionType === 'database' ? '#f97316' : '#94a3b8'
                    }}
                  >
                    Database Server
                  </button>
                </div>
              </div>

              {/* Conditional Inputs */}
              {connectionType === 'csv' && (
                <div style={{ padding: '12px', border: '1px dashed rgba(255,255,255,0.08)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: '#94a3b8', lineHeight: '1.4' }}>
                  Please close this modal and click the <b>Load Points</b> navigation tab in the sidebar header to use our advanced CSV coordinator parser.
                </div>
              )}

              {connectionType === 'folder' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="folder-path">Local Directory Path</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      id="folder-path"
                      type="text"
                      className="form-input"
                      placeholder="C:\GeophysicsExports\Wilhelmshaven"
                      style={{ flexGrow: 1 }}
                      required
                    />
                    <button type="button" className="btn-secondary" style={{ padding: '8px' }}>
                      <FolderOpen size={16} />
                    </button>
                  </div>
                </div>
              )}

              {connectionType === 'shapefile' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="shapefile-upload">Upload Shapefiles (.zip / .shp)</label>
                  <input
                    id="shapefile-upload"
                    type="file"
                    accept=".zip,.shp,.shx,.dbf"
                    className="form-input"
                    required
                  />
                </div>
              )}

              {connectionType === 'database' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="db-connection">PostgreSQL Connection String</label>
                  <input
                    id="db-connection"
                    type="text"
                    className="form-input"
                    value={dbConnString}
                    onChange={(e) => setDbConnString(e.target.value)}
                    placeholder="postgresql://user:pass@localhost:5432/nolte_gpr"
                    required
                  />
                </div>
              )}

              {/* Submit */}
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                <button type="button" className="btn-secondary" onClick={() => setAddDataOpen(false)} style={{ flex: 1 }}>
                  Cancel
                </button>
                {connectionType !== 'csv' && (
                  <button type="submit" className="btn-primary" style={{ flex: 1 }}>
                    Establish Sync
                  </button>
                )}
              </div>

            </form>
          </div>
        </div>
      )}

      {/* Slide animations */}
      <style>{`
        @keyframes slide-in-drawer {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes scale-up {
          from { transform: scale(0.95); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>

    </div>
  );
};
