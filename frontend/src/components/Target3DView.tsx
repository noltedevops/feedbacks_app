import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { makeT, type AppLang } from '../i18n';
import { RotateCcw, AlertTriangle, ShieldCheck, Box } from 'lucide-react';

interface Target3DViewProps {
  point: LocalPoint;
  lang: AppLang;
  height?: number | string;
}

interface Point3D {
  x: number;
  y: number;
  z: number;
}

interface Point2D {
  x: number;
  y: number;
}

export const Target3DView: React.FC<Target3DViewProps> = ({ point, lang, height = 320 }) => {
  const t = useMemo(() => makeT(lang), [lang]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Pit dimensions in meters with sensible physical fallbacks
  const feedback = point.feedback;
  const length = Math.max(feedback?.laenge ?? 0.8, 0.2); // X axis
  const width = Math.max(feedback?.breite ?? 0.5, 0.2); // Y axis
  const actualDepth = Math.max(feedback?.actual_depth ?? point.evaluated_depth ?? 0.6, 0.1); // Z axis (downward)
  const evaluatedDepth = point.evaluated_depth != null && point.evaluated_depth > 0 ? point.evaluated_depth : null;
  const volume = feedback?.m_cube != null ? `${feedback.m_cube} m³` : `${(length * width * actualDepth).toFixed(2)} m³`;
  const finding = feedback?.fundstueck || (feedback?.visited ? 'ohne Fund' : t('N/A'));
  const isSohleClear = (feedback?.sohle_status || '').toLowerCase().trim() === 'frei' ||
                       (feedback?.sohle_status || '').toLowerCase().trim() === 'clear';

  // Camera angles in radians
  const [azimuth, setAzimuth] = useState<number>(0.65); // ~37 degrees
  const [elevation, setElevation] = useState<number>(0.52); // ~30 degrees looking down
  const [zoom, setZoom] = useState<number>(1.0);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; az: number; el: number }>({ x: 0, y: 0, az: 0, el: 0 });

  const resetCamera = useCallback(() => {
    setAzimuth(0.65);
    setElevation(0.52);
    setZoom(1.0);
  }, []);

  // Mouse & Touch interaction handlers
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      az: azimuth,
      el: elevation
    };
  }, [azimuth, elevation]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setAzimuth(dragStartRef.current.az + dx * 0.012);
    // Clamp elevation between -5 deg and 80 deg
    const newElevation = Math.max(0.05, Math.min(1.4, dragStartRef.current.el + dy * 0.012));
    setElevation(newElevation);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    setZoom(z => Math.max(0.5, Math.min(2.5, z - e.deltaY * 0.001)));
  }, []);

  // 3D Rendering Canvas Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2 - 10;

    // Base scale in pixels per meter
    const maxDim = Math.max(length, width, actualDepth, evaluatedDepth ?? 0, 1.2);
    const scale = (Math.min(w, h) * 0.42 / maxDim) * zoom;

    // Axonometric rotation projection:
    // Azimuth around Z, Elevation around horizontal axis
    const cosA = Math.cos(azimuth);
    const sinA = Math.sin(azimuth);
    const cosE = Math.cos(elevation);
    const sinE = Math.sin(elevation);

    const project = (p: Point3D): Point2D => {
      // 1. Rotate around Z (vertical axis)
      const x1 = p.x * cosA - p.y * sinA;
      const y1 = p.x * sinA + p.y * cosA;
      const z1 = p.z; // downward

      // 2. Rotate around horizontal axis (elevation angle)
      // Screen X is horizontal
      const screenX = cx + x1 * scale;
      // Screen Y is vertical (Z goes down on screen, Y goes away/up)
      const screenY = cy + (z1 * cosE - y1 * sinE) * scale;
      return { x: screenX, y: screenY };
    };

    // Style tokens from DOM
    const isDark = document.body.classList.contains('dark-theme');
    const groundGridColor = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 30, 43, 0.12)';
    const groundPlaneFill = isDark ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.015)';
    const textColor = isDark ? '#e8edeb' : '#1c2d37';
    const textMuted = isDark ? '#94a3b8' : '#64748b';
    const wallFill = isDark ? 'rgba(217, 119, 6, 0.06)' : 'rgba(180, 83, 9, 0.06)';
    const pitEdgeColor = isDark ? '#f59e0b' : '#d97706';
    const sensorColor = '#06b6d4'; // Cyan
    const sohleColor = isSohleClear ? '#10b981' : '#ef4444';
    const sohleFill = isSohleClear ? 'rgba(16, 185, 129, 0.22)' : 'rgba(239, 68, 68, 0.25)';

    // 1. Draw Ground Surface Grid (Z = 0)
    const gridSize = Math.max(length, width, 1.2) * 1.6;
    const gridStep = 0.5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = groundGridColor;
    ctx.setLineDash([3, 4]);

    for (let gx = -gridSize; gx <= gridSize + 0.01; gx += gridStep) {
      const pStart = project({ x: gx, y: -gridSize, z: 0 });
      const pEnd = project({ x: gx, y: gridSize, z: 0 });
      ctx.beginPath();
      ctx.moveTo(pStart.x, pStart.y);
      ctx.lineTo(pEnd.x, pEnd.y);
      ctx.stroke();
    }
    for (let gy = -gridSize; gy <= gridSize + 0.01; gy += gridStep) {
      const pStart = project({ x: -gridSize, y: gy, z: 0 });
      const pEnd = project({ x: gridSize, y: gy, z: 0 });
      ctx.beginPath();
      ctx.moveTo(pStart.x, pStart.y);
      ctx.lineTo(pEnd.x, pEnd.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Ground plane fill around the pit
    const gP1 = project({ x: -gridSize, y: -gridSize, z: 0 });
    const gP2 = project({ x: gridSize, y: -gridSize, z: 0 });
    const gP3 = project({ x: gridSize, y: gridSize, z: 0 });
    const gP4 = project({ x: -gridSize, y: gridSize, z: 0 });
    ctx.fillStyle = groundPlaneFill;
    ctx.beginPath();
    ctx.moveTo(gP1.x, gP1.y);
    ctx.lineTo(gP2.x, gP2.y);
    ctx.lineTo(gP3.x, gP3.y);
    ctx.lineTo(gP4.x, gP4.y);
    ctx.closePath();
    ctx.fill();

    // 2. Excavation Pit Coordinates
    const hx = length / 2;
    const hy = width / 2;

    // Top 4 corners at surface Z = 0
    const topCorners: Point3D[] = [
      { x: -hx, y: -hy, z: 0 },
      { x: hx, y: -hy, z: 0 },
      { x: hx, y: hy, z: 0 },
      { x: -hx, y: hy, z: 0 }
    ];

    // Bottom 4 corners at pit base Z = actualDepth
    const btmCorners: Point3D[] = [
      { x: -hx, y: -hy, z: actualDepth },
      { x: hx, y: -hy, z: actualDepth },
      { x: hx, y: hy, z: actualDepth },
      { x: -hx, y: hy, z: actualDepth }
    ];

    const top2D = topCorners.map(project);
    const btm2D = btmCorners.map(project);

    // Draw pit sidewalls
    ctx.fillStyle = wallFill;
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      ctx.beginPath();
      ctx.moveTo(top2D[i].x, top2D[i].y);
      ctx.lineTo(top2D[next].x, top2D[next].y);
      ctx.lineTo(btm2D[next].x, btm2D[next].y);
      ctx.lineTo(btm2D[i].x, btm2D[i].y);
      ctx.closePath();
      ctx.fill();
    }

    // 3. Draw Evaluated Depth Reference Frame (Sensor Depth)
    if (evaluatedDepth != null) {
      const evalCorners: Point3D[] = [
        { x: -hx * 1.05, y: -hy * 1.05, z: evaluatedDepth },
        { x: hx * 1.05, y: -hy * 1.05, z: evaluatedDepth },
        { x: hx * 1.05, y: hy * 1.05, z: evaluatedDepth },
        { x: -hx * 1.05, y: hy * 1.05, z: evaluatedDepth }
      ];
      const eval2D = evalCorners.map(project);

      ctx.save();
      ctx.strokeStyle = sensorColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';

      ctx.beginPath();
      ctx.moveTo(eval2D[0].x, eval2D[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(eval2D[i].x, eval2D[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Sensor Tag
      const evalTagPos = eval2D[1];
      ctx.font = '10px Montserrat, sans-serif';
      ctx.fillStyle = sensorColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Sensor: ${evaluatedDepth} m`, evalTagPos.x + 6, evalTagPos.y);
      ctx.restore();
    }

    // 4. Draw Pit Floor (Sohle) Plane
    ctx.save();
    ctx.fillStyle = sohleFill;
    ctx.strokeStyle = sohleColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(btm2D[0].x, btm2D[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(btm2D[i].x, btm2D[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Sohle Center Badge
    const btmCenter = project({ x: 0, y: 0, z: actualDepth });
    ctx.font = 'bold 11px Montserrat, sans-serif';
    ctx.fillStyle = sohleColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isSohleClear ? `✓ Sohle: Frei (${actualDepth} m)` : `⚠ Sohle: Nicht Frei (${actualDepth} m)`, btmCenter.x, btmCenter.y);
    ctx.restore();

    // 5. Draw Pit Frame Struts (Corner Edges)
    ctx.strokeStyle = pitEdgeColor;
    ctx.lineWidth = 1.8;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(top2D[i].x, top2D[i].y);
      ctx.lineTo(btm2D[i].x, btm2D[i].y);
      ctx.stroke();
    }

    // Top Rim
    ctx.lineWidth = 2;
    ctx.strokeStyle = pitEdgeColor;
    ctx.beginPath();
    ctx.moveTo(top2D[0].x, top2D[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(top2D[i].x, top2D[i].y);
    ctx.closePath();
    ctx.stroke();

    // 6. Draw Finding Procedural 3D Mesh
    if (finding && finding !== 'ohne Fund' && finding !== t('N/A')) {
      const objZ = actualDepth - 0.08;
      const objCenter = project({ x: 0, y: 0, z: objZ });

      ctx.save();
      if (finding.includes('Eisenstange') || finding.includes('Eisenstab')) {
        // Metallic rod
        const rodLength = Math.min(length * 0.7, 0.6);
        const pA = project({ x: -rodLength / 2, y: 0, z: objZ });
        const pB = project({ x: rodLength / 2, y: 0, z: objZ });
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
        ctx.stroke();
        // Highlight
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y - 2);
        ctx.lineTo(pB.x, pB.y - 2);
        ctx.stroke();
      } else if (finding.includes('Stein')) {
        // Faceted boulder
        ctx.fillStyle = '#78716c';
        ctx.strokeStyle = '#44403c';
        ctx.lineWidth = 1.5;
        const stoneR = 14;
        ctx.beginPath();
        ctx.moveTo(objCenter.x - stoneR, objCenter.y);
        ctx.lineTo(objCenter.x - stoneR * 0.4, objCenter.y - stoneR * 0.8);
        ctx.lineTo(objCenter.x + stoneR * 0.7, objCenter.y - stoneR * 0.6);
        ctx.lineTo(objCenter.x + stoneR, objCenter.y + stoneR * 0.2);
        ctx.lineTo(objCenter.x + stoneR * 0.2, objCenter.y + stoneR * 0.8);
        ctx.lineTo(objCenter.x - stoneR * 0.7, objCenter.y + stoneR * 0.6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // General metallic iron object / scrap box
        const sL = Math.min(length * 0.35, 0.25);
        const sW = Math.min(width * 0.4, 0.2);
        const sH = 0.08;
        const oTop = [
          project({ x: -sL, y: -sW, z: objZ - sH }),
          project({ x: sL, y: -sW, z: objZ - sH }),
          project({ x: sL, y: sW, z: objZ - sH }),
          project({ x: -sL, y: sW, z: objZ - sH })
        ];
        ctx.fillStyle = isDark ? '#64748b' : '#475569';
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(oTop[0].x, oTop[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(oTop[i].x, oTop[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Finding Badge text
      ctx.font = '600 10px Montserrat, sans-serif';
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.fillText(finding, objCenter.x, objCenter.y - 14);
      ctx.restore();
    }

    // 7. Dimension Rulers & Annotations
    ctx.save();
    ctx.font = '10px Montserrat, sans-serif';
    ctx.fillStyle = textMuted;

    // Length annotation along top front edge (top2D[0] to top2D[1])
    const midLen = { x: (top2D[0].x + top2D[1].x) / 2, y: (top2D[0].y + top2D[1].y) / 2 };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`L: ${length} m`, midLen.x, midLen.y - 4);

    // Width annotation along top side edge (top2D[1] to top2D[2])
    const midWid = { x: (top2D[1].x + top2D[2].x) / 2, y: (top2D[1].y + top2D[2].y) / 2 };
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`W: ${width} m`, midWid.x + 6, midWid.y);

    // Depth ruler on the front-left corner (top2D[0] to btm2D[0])
    const midDep = { x: (top2D[0].x + btm2D[0].x) / 2, y: (top2D[0].y + btm2D[0].y) / 2 };
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`D: ${actualDepth} m`, midDep.x - 6, midDep.y);

    ctx.restore();
    ctx.restore();
  }, [length, width, actualDepth, evaluatedDepth, isSohleClear, finding, azimuth, elevation, zoom, t]);

  return (
    <div className="target-3d-container">
      <div className="target-3d-header">
        <div className="target-3d-title">
          <Box size={16} className="target-3d-icon" />
          <span>{t('3D Pit View')}</span>
          <span className="target-3d-vol num">{volume}</span>
        </div>
        <button
          type="button"
          className="btn-ghost target-3d-reset"
          onClick={resetCamera}
          title={t('Reset View')}
        >
          <RotateCcw size={14} />
          <span>{t('Reset View')}</span>
        </button>
      </div>

      <div className="target-3d-viewport" style={{ height }}>
        <canvas
          ref={canvasRef}
          className="target-3d-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        />
        <div className="target-3d-hint">
          <span>{t('Drag to rotate')}</span>
        </div>
      </div>

      <div className="target-3d-footer">
        <div className="target-3d-badge" data-clear={isSohleClear}>
          {isSohleClear ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
          <span>{isSohleClear ? t('Certified Clear') : t('Nicht Frei')}</span>
        </div>
        <div className="target-3d-finding">
          <span className="target-3d-finding-label">{t('Finding')}:</span>
          <strong>{finding}</strong>
        </div>
      </div>
    </div>
  );
};
