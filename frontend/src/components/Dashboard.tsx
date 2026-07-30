import React from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { makeT, type AppLang } from '../i18n';
import { 
  CheckCircle2, 
  Database,
  Clock,
  Briefcase
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';

interface DashboardProps {
  lang: AppLang;
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
  filterInstrument: string;
  setFilterInstrument: (instrument: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  lang,
  points,
  filteredPoints,
  selectedPoint, 
  onSelectPoint, 
  isOnline: _isOnline,
  onSeedRequest: _onSeedRequest,
  addDataOpen: _addDataOpen,
  setAddDataOpen: _setAddDataOpen,
  filterStatus,
  setFilterStatus,
  filterInstrument,
  setFilterInstrument
}) => {
  const t = makeT(lang);

  // Filter points based on selected instrument for dashboard metrics
  const dashboardPoints = points.filter(p => 
    filterInstrument === 'all' || 
    (p.instrument && p.instrument.toLowerCase() === filterInstrument.toLowerCase())
  );

  // Calculate statistics
  const total = dashboardPoints.length;
  const investigated = dashboardPoints.filter(p => p.local_status === 'investigated').length;
  const pending = total - investigated;
  
  // Unique Project IDs Count
  const projectIds = Array.from(new Set(dashboardPoints.map(p => p.project_id || '11-24-2736')));
  const projectsCount = projectIds.length;

  // Total Excavated Volume & progress percentage
  const totalVolume = dashboardPoints.reduce((sum, p) => sum + (p.feedback?.m_cube || 0), 0);
  const targetCapacity = 250; // Target capacity in cubic meters
  const volumePercentage = Math.min(100, Math.round((totalVolume / targetCapacity) * 100));
  const formattedVolume = totalVolume.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " m³";

  // 1. Fundstück Status Chart (sorted low-to-high frequency of finding)
  const fundstueckMap: { [key: string]: number } = {};
  const standardOptions = ['ohne Fund', 'Eisenteil', 'Eisenstange / Eisenstab', 'Eisendraht', 'Eisenseil', 'Eisennägel', 'Steine', 'Sonstige'];
  standardOptions.forEach(opt => { fundstueckMap[opt] = 0; });

  dashboardPoints.forEach(p => {
    if (p.local_status === 'investigated' && p.feedback) {
      const key = p.feedback.fundstueck || 'ohne Fund';
      fundstueckMap[key] = (fundstueckMap[key] || 0) + 1;
    }
  });

  const fundstueckChartData = Object.keys(fundstueckMap)
    .map(key => ({
      name: key,
      count: fundstueckMap[key]
    }))
    .filter(item => item.count > 0 || standardOptions.includes(item.name))
    .sort((a, b) => a.count - b.count);

  // 2. Sohle Status split by Fundstück
  const sohleSplitMap: { [key: string]: { name: string; 'Frei': number; 'Nicht Frei': number } } = {};
  dashboardPoints.forEach(p => {
    if (p.local_status === 'investigated' && p.feedback) {
      const fund = p.feedback.fundstueck || 'ohne Fund';
      const sohle = p.feedback.sohle_status || 'Frei';
      if (!sohleSplitMap[fund]) {
        sohleSplitMap[fund] = { name: fund, 'Frei': 0, 'Nicht Frei': 0 };
      }
      if (sohle === 'Frei') {
        sohleSplitMap[fund]['Frei']++;
      } else {
        sohleSplitMap[fund]['Nicht Frei']++;
      }
    }
  });
  const sohleSplitChartData = Object.values(sohleSplitMap);

  // 3. Evaluated vs Excavated Depth Distribution comparison data
  const depthIntervals = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
  const depthCompData = depthIntervals.map(limit => ({
    limit: `${limit}m`,
    'Evaluated (Sensor)': 0,
    'Excavated (Actual)': 0
  }));

  dashboardPoints.forEach(p => {
    if (p.local_status === 'investigated' && p.feedback) {
      const evalD = p.evaluated_depth || 0;
      const execD = p.feedback.actual_depth || 0;
      
      if (evalD > 0) {
        for (let i = 0; i < depthIntervals.length; i++) {
          if (evalD <= depthIntervals[i]) {
            depthCompData[i]['Evaluated (Sensor)']++;
            break;
          }
        }
      }
      if (execD > 0) {
        for (let i = 0; i < depthIntervals.length; i++) {
          if (execD <= depthIntervals[i]) {
            depthCompData[i]['Excavated (Actual)']++;
            break;
          }
        }
      }
    }
  });

  // 4. Geophysics KPI Card calculation
  let totalDiff = 0;
  let totalBias = 0;
  let validDepthPairs = 0;
  let investigatedCount = 0;
  let ohneFundCount = 0;

  dashboardPoints.forEach(p => {
    if (p.local_status === 'investigated' && p.feedback) {
      investigatedCount++;
      if (p.feedback.fundstueck === 'ohne Fund') {
        ohneFundCount++;
      }
      
      const evalD = p.evaluated_depth;
      const execD = p.feedback.actual_depth;
      if (evalD !== null && execD !== null && evalD !== undefined && execD !== undefined) {
        totalDiff += Math.abs(evalD - execD);
        totalBias += (evalD - execD);
        validDepthPairs++;
      }
    }
  });

  const meanDepthError = validDepthPairs > 0 ? (totalDiff / validDepthPairs).toFixed(2) : '0.00';
  const rawBias = validDepthPairs > 0 ? totalBias / validDepthPairs : 0;
  const biasText = validDepthPairs > 0
    ? (rawBias > 0.02 ? `${t('Too Deep')} (+${rawBias.toFixed(2)}m)` : (rawBias < -0.02 ? `${t('Too Shallow')} (${rawBias.toFixed(2)}m)` : `${t('Balanced')} (${rawBias.toFixed(2)}m)`))
    : t('N/A');
  const falsePositiveRate = investigatedCount > 0 ? Math.round((ohneFundCount / investigatedCount) * 100) : 0;

  // 5. Depth/Metrics per Fundstück Stacked Serial Chart data
  const metricsMap: { [key: string]: { count: number; depthSum: number; lengthSum: number; widthSum: number; volSum: number } } = {};
  dashboardPoints.forEach(p => {
    if (p.local_status === 'investigated' && p.feedback) {
      const fund = p.feedback.fundstueck || 'ohne Fund';
      if (!metricsMap[fund]) {
        metricsMap[fund] = { count: 0, depthSum: 0, lengthSum: 0, widthSum: 0, volSum: 0 };
      }
      metricsMap[fund].count++;
      metricsMap[fund].depthSum += p.feedback.actual_depth || 0;
      metricsMap[fund].lengthSum += p.feedback.laenge || 0;
      metricsMap[fund].widthSum += p.feedback.breite || 0;
      metricsMap[fund].volSum += p.feedback.m_cube || 0;
    }
  });

  const metricsChartData = Object.keys(metricsMap).map(key => {
    const val = metricsMap[key];
    return {
      name: key,
      'Depth (m)': Number((val.depthSum / val.count).toFixed(2)),
      'Length (m)': Number((val.lengthSum / val.count).toFixed(2)),
      'Width (m)': Number((val.widthSum / val.count).toFixed(2)),
      'Volume (m³)': Number((val.volSum / val.count).toFixed(2))
    };
  });

  return (
    <div style={{ 
      position: 'relative', 
      width: '100%', 
      height: '100%', 
      overflow: 'hidden', 
      boxSizing: 'border-box', 
      pointerEvents: 'none' 
    }}>
      
      {/* 1. Horizontal top-floating Dashboard Section Header */}
      <div className="glass-panel" style={{ 
        position: 'absolute',
        top: '12px',
        left: '12px',
        right: '384px',
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '10px 16px', 
        borderRadius: '12px', 
        pointerEvents: 'auto',
        zIndex: 10
      }}>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#10b981', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {t('Operations Overview')}
            </span>
            <h2 style={{ fontSize: '1.1rem', color: '#fff', fontWeight: 800, margin: 0, fontFamily: 'var(--font-heading)' }}>
              {t('Clearance Analytics Dashboard')}
            </h2>
          </div>
          
          {/* 5th KPI Card: Total Excavated Volume */}
          <div className="glass-card" style={{
            padding: '4px 10px',
            borderRadius: '6px',
            borderLeft: '3px solid #fa5f1c',
            backgroundColor: 'rgba(255,255,255,0.02)',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            minWidth: '140px'
          }}>
            <div style={{ fontSize: '0.48rem', color: '#8c9f96', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1 }}>{t('TOTAL EXCAVATED VOLUME')}</div>
            <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#fa5f1c', fontFamily: 'var(--font-heading)', lineHeight: 1.1 }}>
              {formattedVolume}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '1px' }}>
              <div style={{ height: '3px', flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '1.5px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${volumePercentage}%`, backgroundColor: '#fa5f1c', borderRadius: '1.5px' }} />
              </div>
              <span style={{ fontSize: '0.45rem', color: '#8c9f96', fontWeight: 700 }}>{volumePercentage}%</span>
            </div>
          </div>
        </div>
        
        {/* Dropdown Selector */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '0.68rem', color: '#8c9f96', fontWeight: 700 }}>{t('INSTRUMENT:')}</span>
          <select 
            value={filterInstrument} 
            onChange={(e) => setFilterInstrument(e.target.value)}
            className="form-input"
            style={{ 
              fontSize: '0.72rem', 
              padding: '4px 20px 4px 8px', 
              fontWeight: 700, 
              backgroundColor: 'rgba(10, 22, 18, 0.6)', 
              borderColor: 'rgba(255, 255, 255, 0.06)', 
              color: '#fff', 
              cursor: 'pointer',
              borderRadius: '6px',
              height: '26px'
            }}
          >
            <option value="all">{t('All Instruments')}</option>
            <option value="georadar">{t('Georadar Array')}</option>
            <option value="magnetic">{t('Magnetics')}</option>
          </select>
        </div>
      </div>

      {/* 2. LEFT COLUMN: Floating analytics widgets & stacked charts */}
      <div style={{
        position: 'absolute',
        top: '90px',
        left: '12px',
        bottom: '12px',
        width: '360px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 10
      }}>
        
        {/* Indicators Widget Grid (2x2 Grid of simple number panels) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', flexShrink: 0 }}>
          {/* Widget 1: Total Targets */}
          <div className="glass-panel" style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '3px solid #f97316', borderRadius: '8px' }}>
            <div style={{ backgroundColor: 'rgba(249, 115, 22, 0.12)', padding: '5px', borderRadius: '5px', color: '#f97316', display: 'flex', alignItems: 'center' }}>
              <Database size={14} />
            </div>
            <div>
              <div style={{ fontSize: '0.5rem', color: '#8c9f96', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{t('TOTAL TARGETS')}</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 800, fontFamily: 'var(--font-heading)', color: '#fff' }}>{total}</div>
            </div>
          </div>

          {/* Widget 2: Investigated */}
          <div className="glass-panel" style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '3px solid #10b981', borderRadius: '8px' }}>
            <div style={{ backgroundColor: 'rgba(16, 185, 129, 0.12)', padding: '5px', borderRadius: '5px', color: '#10b981', display: 'flex', alignItems: 'center' }}>
              <CheckCircle2 size={14} />
            </div>
            <div>
              <div style={{ fontSize: '0.5rem', color: '#8c9f96', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{t('INVESTIGATED')}</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 800, color: '#10b981', fontFamily: 'var(--font-heading)' }}>{investigated}</div>
            </div>
          </div>

          {/* Widget 3: Pending */}
          <div className="glass-panel" style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '3px solid #ef4444', borderRadius: '8px' }}>
            <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)', padding: '5px', borderRadius: '5px', color: '#ef4444', display: 'flex', alignItems: 'center' }}>
              <Clock size={14} />
            </div>
            <div>
              <div style={{ fontSize: '0.5rem', color: '#8c9f96', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{t('PENDING')}</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 800, color: '#ef4444', fontFamily: 'var(--font-heading)' }}>{pending}</div>
            </div>
          </div>

          {/* Widget 4: Survey Projects */}
          <div className="glass-panel" style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '3px solid #8b5cf6', borderRadius: '8px' }}>
            <div style={{ backgroundColor: 'rgba(139, 92, 246, 0.12)', padding: '5px', borderRadius: '5px', color: '#8b5cf6', display: 'flex', alignItems: 'center' }}>
              <Briefcase size={14} />
            </div>
            <div>
              <div style={{ fontSize: '0.5rem', color: '#8c9f96', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{t('SURVEY PROJECTS')}</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 800, color: '#a78bfa', fontFamily: 'var(--font-heading)' }}>{projectsCount}</div>
            </div>
          </div>
        </div>

        {/* Card 1: Fundstück Status Distribution */}
        <div className="glass-panel" style={{ padding: '10px 12px', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
            <span style={{ fontSize: '0.5rem', fontWeight: 800, color: '#f97316', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t('Findings Status')}</span>
            <h3 style={{ fontSize: '0.72rem', fontWeight: 800, color: '#fff', margin: 0 }}>{t('Grouped Findings (Sorted Low to High)')}</h3>
          </div>
          <div style={{ width: '100%', flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={fundstueckChartData}
                margin={{ top: 5, right: 5, left: -32, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="name" stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <YAxis stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: 8 }} />
                <Bar dataKey="count" name={t('Frequency')} fill="#fa5f1c" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Card 2: Sohle Status Split by Fundstück */}
        <div className="glass-panel" style={{ padding: '10px 12px', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
            <span style={{ fontSize: '0.5rem', fontWeight: 800, color: '#10b981', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t('Excavation Integrity')}</span>
            <h3 style={{ fontSize: '0.72rem', fontWeight: 800, color: '#fff', margin: 0 }}>{t('Sohle Status Split by Finding')}</h3>
          </div>
          <div style={{ width: '100%', flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={sohleSplitChartData}
                margin={{ top: 5, right: 5, left: -32, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="name" stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <YAxis stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: 8 }} />
                <Legend verticalAlign="top" height={16} iconSize={6} wrapperStyle={{ fontSize: 7 }} />
                <Bar dataKey="Frei" name={t('Frei (Clear)')} fill="#10b981" stackId="sohle" />
                <Bar dataKey="Nicht Frei" name={t('Nicht Frei')} fill="#ef4444" stackId="sohle" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>

      {/* 3. RIGHT COLUMN: Target Clearance Log points listing and charts stacked vertically */}
      <div style={{
        position: 'absolute',
        top: '12px',
        right: '12px',
        bottom: '12px',
        width: '360px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 10
      }}>
        
        {/* Clearance Log floating panel */}
        <div className="glass-panel" style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '8px', 
          padding: '12px', 
          borderRadius: '12px', 
          flex: 1.2,
          minHeight: 0,
          overflow: 'hidden'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <span style={{ fontSize: '0.5rem', fontWeight: 800, color: '#10b981', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t('Target Log')}</span>
              <h3 style={{ fontSize: '0.75rem', fontWeight: 800, color: '#fff', margin: 0 }}>{t('Excavated Targets Database')} ({filteredPoints.length})</h3>
            </div>
            
            <select 
              value={filterStatus} 
              onChange={(e) => setFilterStatus(e.target.value)}
              className="form-input"
              style={{ fontSize: '0.65rem', padding: '2px 14px 2px 4px', height: '20px', backgroundColor: 'rgba(10, 22, 18, 0.6)', borderColor: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer', borderRadius: '4px' }}
            >
              <option value="all">{t('All Targets')}</option>
              <option value="investigated">{t('Investigated')}</option>
              <option value="pending">{t('Pending')}</option>
            </select>
          </div>

          <div style={{ 
            display: 'flex',
            flexDirection: 'column',
            gap: '6px', 
            overflowY: 'auto', 
            flex: 1,
            paddingRight: '2px'
          }}>
            {filteredPoints.map((point: LocalPoint) => {
              const isInvestigated = point.local_status === 'investigated';
              let statusText = t('PENDING');
              let badgeColor = '#ef4444';
              
              if (isInvestigated && point.feedback) {
                const fund = point.feedback.fundstueck || 'ohne Fund';
                statusText = fund === 'Sonstige' ? (point.feedback.other || 'Sonstige') : fund;
                badgeColor = fund === 'ohne Fund' ? '#64748b' : '#10b981';
              }

              return (
                <div
                  key={point.id}
                  className={`target-card-white ${selectedPoint?.id === point.id ? 'active' : ''}`}
                  onClick={() => { onSelectPoint(point); }}
                  style={{ 
                    padding: '6px 8px', 
                    borderRadius: '6px', 
                    backgroundColor: '#fff', 
                    boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1px',
                    border: selectedPoint?.id === point.id ? '1.5px solid #10b981' : '1px solid #e2e8f0',
                    cursor: 'pointer',
                    flexShrink: 0
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 800, fontSize: '0.68rem', color: '#0f172a' }}>VM {point.vm_nr}</span>
                    <span style={{ 
                       fontSize: '0.5rem', 
                       fontWeight: 800,
                       padding: '1px 4px', 
                       borderRadius: '3px',
                       backgroundColor: 'rgba(0,0,0,0.04)',
                       color: badgeColor,
                       border: `1px solid ${badgeColor}22`,
                       whiteSpace: 'nowrap',
                       overflow: 'hidden',
                       textOverflow: 'ellipsis',
                       maxWidth: '90px'
                    }} title={statusText}>
                      {statusText.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.55rem', color: '#64748b', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {point.instrument?.toUpperCase()} • {point.layer?.replace('Stoerkoerper ', '') || t('Target')}
                  </div>
                  
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between',
                    marginTop: '1px',
                    padding: '1px 4px',
                    backgroundColor: 'rgba(0, 0, 0, 0.02)',
                    borderRadius: '3px',
                    fontSize: '0.55rem'
                  }}>
                    <span style={{ color: '#94a3b8', fontWeight: 700 }}>{t('EVAL')}: {point.evaluated_depth ? `${point.evaluated_depth}m` : t('N/A')}</span>
                    {isInvestigated && point.feedback?.actual_depth && (
                      <span style={{ color: '#10b981', fontWeight: 800 }}>{t('EXCAV')}: {point.feedback.actual_depth}m</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Card 4: Evaluated vs Excavated Depth Curve + KPI Summary */}
        <div className="glass-panel" style={{ padding: '10px 12px', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
            <span style={{ fontSize: '0.5rem', fontWeight: 800, color: '#38bdf8', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t('Sensor Accuracy')}</span>
            <h3 style={{ fontSize: '0.72rem', fontWeight: 800, color: '#fff', margin: 0 }}>{t('Evaluated vs Excavated Depth')}</h3>
          </div>
          
          <div style={{ flex: 1, minHeight: 0, width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={depthCompData}
                margin={{ top: 5, right: 5, left: -32, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="colorEval" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#fa5f1c" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#fa5f1c" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorExec" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="limit" stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <YAxis stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: 8 }} />
                <Legend verticalAlign="top" height={16} iconSize={6} wrapperStyle={{ fontSize: 7 }} />
                <Area type="monotone" dataKey="Evaluated (Sensor)" name={t('Evaluated (Sensor)')} stroke="#fa5f1c" fillOpacity={1} fill="url(#colorEval)" strokeWidth={1.2} />
                <Area type="monotone" dataKey="Excavated (Actual)" name={t('Excavated (Actual)')} stroke="#10b981" fillOpacity={1} fill="url(#colorExec)" strokeWidth={1.2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          
          {/* Geophysics KPI mini list */}
          <div className="glass-card" style={{ padding: '6px 8px', display: 'flex', justifyContent: 'space-between', gap: '6px', border: '1px solid rgba(255,255,255,0.04)', fontSize: '0.55rem', flexShrink: 0 }}>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ color: '#8c9f96', fontWeight: 700 }}>{t('MEAN ERROR')}</div>
              <strong style={{ color: '#fff', fontSize: '0.68rem' }}>&plusmn; {meanDepthError}m</strong>
            </div>
            <div style={{ textAlign: 'center', flex: 1, borderLeft: '1px solid rgba(255,255,255,0.06)', borderRight: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ color: '#8c9f96', fontWeight: 700 }}>{t('ESTIMATION BIAS')}</div>
              <strong style={{ color: '#fa5f1c', fontSize: '0.62rem', display: 'block', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={biasText}>{biasText}</strong>
            </div>
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ color: '#8c9f96', fontWeight: 700 }}>{t('FPR (EMPTY)')}</div>
              <strong style={{ color: '#ef4444', fontSize: '0.68rem' }}>{falsePositiveRate}%</strong>
            </div>
          </div>
        </div>

        {/* Card 5: Metrics per Fundstück (Stacked Serial Chart) */}
        <div className="glass-panel" style={{ padding: '10px 12px', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
            <span style={{ fontSize: '0.5rem', fontWeight: 800, color: '#fa5f1c', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t('Target Profiling')}</span>
            <h3 style={{ fontSize: '0.72rem', fontWeight: 800, color: '#fff', margin: 0 }}>{t('Target Dimensions (Stacked Serial Chart)')}</h3>
          </div>
          
          <div style={{ width: '100%', flex: 1, minHeight: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={metricsChartData}
                margin={{ top: 5, right: 5, left: -32, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="name" stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <YAxis stroke="#8c9f96" fontSize={7} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: 8 }} />
                <Legend verticalAlign="top" height={16} iconSize={6} wrapperStyle={{ fontSize: 7 }} />
                <Bar dataKey="Depth (m)" name={t('Depth (m)')} fill="#fa5f1c" stackId="metrics" />
                <Bar dataKey="Length (m)" name={t('Length (m)')} fill="#38bdf8" stackId="metrics" />
                <Bar dataKey="Width (m)" name={t('Width (m)')} fill="#e2e8f0" stackId="metrics" />
                <Bar dataKey="Volume (m³)" name={t('Volume (m³)')} fill="#10b981" stackId="metrics" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>

    </div>
  );
};
