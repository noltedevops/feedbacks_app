import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { makeT, type AppLang } from '../i18n';
import { RotateCcw, AlertTriangle, ShieldCheck, Box } from 'lucide-react';
import { isSohleClear as isSohleClearStatus } from '../dashboardStats';

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

type FindingShape = 'rod' | 'stone' | 'nails' | 'wire' | 'rope' | 'iron' | 'other';

/** Which solid stands in for a Fundstück. Free text is matched loosely, so "Steine" and
 *  "großer Stein" both draw a rock; anything unrecognised draws a plain block. */
const findingShape = (finding: string): FindingShape => {
  const f = finding.toLowerCase();
  if (f.includes('eisenstange') || f.includes('eisenstab')) return 'rod';
  if (f.includes('stein')) return 'stone';
  if (f.includes('nägel') || f.includes('nagel') || f.includes('naegel')) return 'nails';
  if (f.includes('draht')) return 'wire';
  if (f.includes('seil')) return 'rope';
  if (f.includes('eisen')) return 'iron';
  return 'other';
};

export const Target3DView: React.FC<Target3DViewProps> = ({ point, lang, height = 320 }) => {
  const t = useMemo(() => makeT(lang), [lang]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Pit dimensions in metres. A dimension the crew did not record still needs a size to
  // draw, so it falls back to a typical pit - but its label says "≈" and the volume
  // says "est.", so a stand-in is never read as a measurement.
  const feedback = point.feedback;
  const length = Math.max(feedback?.laenge ?? 0.8, 0.2); // X axis
  const width = Math.max(feedback?.breite ?? 0.5, 0.2); // Y axis
  const actualDepth = Math.max(feedback?.actual_depth ?? point.evaluated_depth ?? 0.6, 0.1); // Z axis (downward)
  const lengthTag = feedback?.laenge != null ? '' : '≈ ';
  const widthTag = feedback?.breite != null ? '' : '≈ ';
  const depthTag = feedback?.actual_depth != null ? '' : '≈ ';
  const evaluatedDepth = point.evaluated_depth != null && point.evaluated_depth > 0 ? point.evaluated_depth : null;
  const volume = feedback?.m_cube != null
    ? `${feedback.m_cube} m³`
    : `≈ ${(length * width * actualDepth).toFixed(2)} m³ (${t('est.')})`;
  const finding = feedback?.fundstueck || (feedback?.visited ? 'ohne Fund' : t('N/A'));
  const isSohleClear = isSohleClearStatus(feedback?.sohle_status);

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
    ctx.fillText(isSohleClear ? `✓ Sohle: Frei (${depthTag}${actualDepth} m)` : `⚠ Sohle: Nicht Frei (${depthTag}${actualDepth} m)`, btmCenter.x, btmCenter.y);
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

    // 6. Draw the finding as a solid resting on the pit floor. Every shape is built in
    // pit metres and goes through project(), so it turns and zooms with the pit, and its
    // faces are shaded by a fixed light so they read as volumes, not flat cut-outs.
    if (finding && finding !== 'ohne Fund' && finding !== t('N/A')) {
      const kind = findingShape(finding);
      const floorZ = actualDepth;
      type RGB = [number, number, number];
      const faces: { pts: Point3D[]; color: RGB }[] = [];
      const lines: { pts: Point3D[]; width: number; color: string }[] = [];

      const addBox = (c: Point3D, bx: number, by: number, bz: number, color: RGB) => {
        const v = ([sx, sy, sz]: number[]): Point3D => ({ x: c.x + sx * bx, y: c.y + sy * by, z: c.z + sz * bz });
        const quads = [
          [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]], // top (z points down)
          [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], // bottom
          [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
          [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
          [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]],
          [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]
        ];
        quads.forEach(q => faces.push({ pts: q.map(v), color }));
      };

      // Low-poly rock: an octahedron with uneven radii, lumpy but still convex.
      const addRock = (c: Point3D, r: number, color: RGB) => {
        const top = { x: c.x + r * 0.1, y: c.y - r * 0.05, z: c.z - r * 0.85 };
        const btm = { x: c.x, y: c.y, z: c.z + r * 0.7 };
        const ring = [
          { x: c.x + r * 1.1, y: c.y + r * 0.1, z: c.z },
          { x: c.x + r * 0.1, y: c.y + r * 0.9, z: c.z - r * 0.1 },
          { x: c.x - r * 1.0, y: c.y - r * 0.05, z: c.z + r * 0.05 },
          { x: c.x - r * 0.05, y: c.y - r * 0.8, z: c.z }
        ];
        for (let k = 0; k < 4; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % 4];
          faces.push({ pts: [top, a, b], color });
          faces.push({ pts: [btm, b, a], color });
        }
      };

      const iron: RGB = isDark ? [148, 163, 184] : [100, 116, 139];
      const rust: RGB = [154, 88, 48];
      const stone: RGB = [120, 113, 108];
      let objTopZ: number;

      if (kind === 'rod') {
        const r = 0.025;
        addBox({ x: 0, y: 0, z: floorZ - r }, Math.min(length * 0.75, 0.7) / 2, r, r, iron);
        objTopZ = floorZ - 2 * r;
      } else if (kind === 'stone') {
        const r = Math.min(length, width) * 0.18;
        addRock({ x: 0, y: 0, z: floorZ - r * 0.7 }, r, stone);
        objTopZ = floorZ - r * 1.55;
      } else if (kind === 'nails') {
        // A few nails lying at different angles: a thin shank with a small head.
        [[-0.12, -0.05, 0.3], [0.02, 0.06, -0.6], [0.14, -0.04, 1.1], [-0.02, -0.1, 2.0]].forEach(([nx, ny, ang]) => {
          const dx = Math.cos(ang) * 0.05;
          const dy = Math.sin(ang) * 0.05;
          lines.push({ pts: [{ x: nx - dx, y: ny - dy, z: floorZ - 0.01 }, { x: nx + dx, y: ny + dy, z: floorZ - 0.01 }], width: 0.012, color: '#64748b' });
          addBox({ x: nx - dx, y: ny - dy, z: floorZ - 0.012 }, 0.012, 0.012, 0.006, iron);
        });
        objTopZ = floorZ - 0.03;
      } else if (kind === 'wire' || kind === 'rope') {
        // A loose coil along the floor; rope is drawn thicker than wire.
        const span = Math.min(length * 0.6, 0.5);
        const pts: Point3D[] = [];
        for (let k = 0; k <= 40; k++) {
          const u = k / 40;
          pts.push({
            x: -span / 2 + u * span + Math.sin(u * Math.PI * 6) * 0.03,
            y: Math.cos(u * Math.PI * 6) * Math.min(width * 0.2, 0.08),
            z: floorZ - 0.015 - Math.max(0, Math.sin(u * Math.PI * 6)) * 0.02
          });
        }
        lines.push({ pts, width: kind === 'rope' ? 0.022 : 0.008, color: kind === 'rope' ? '#78716c' : '#94a3b8' });
        objTopZ = floorZ - 0.04;
      } else {
        // Any other find (Eisenteil, Sonstige, free text): a solid block, rusty if iron.
        const sH = 0.06;
        addBox({ x: 0, y: 0, z: floorZ - sH }, Math.min(length * 0.3, 0.22), Math.min(width * 0.3, 0.16), sH, kind === 'iron' ? rust : iron);
        objTopZ = floorZ - 2 * sH;
      }

      // Distance towards the camera, for back-to-front (painter's) ordering of faces.
      const towardCamera = (p: Point3D) => -((p.x * sinA + p.y * cosA) * cosE + p.z * sinE);
      const centroid = (pts: Point3D[]): Point3D => ({
        x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
        y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
        z: pts.reduce((a, p) => a + p.z, 0) / pts.length
      });
      // Light from above and slightly in front; up is -z because z points down.
      const light = { x: 0.3, y: -0.4, z: -0.87 };

      ctx.save();
      ctx.lineJoin = 'round';
      faces
        .map(f => ({ ...f, depth: towardCamera(centroid(f.pts)) }))
        .sort((a, b) => a.depth - b.depth)
        .forEach(f => {
          const [a, b, d] = f.pts;
          const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
          const v = { x: d.x - a.x, y: d.y - a.y, z: d.z - a.z };
          const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
          const lambert = Math.abs(n.x * light.x + n.y * light.y + n.z * light.z) / (Math.hypot(n.x, n.y, n.z) || 1);
          const shade = 0.45 + 0.55 * lambert;
          const [r, g, bl] = f.color.map(ch => Math.round(ch * shade));
          const p2 = f.pts.map(project);
          ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
          ctx.lineWidth = 0.75;
          ctx.beginPath();
          ctx.moveTo(p2[0].x, p2[0].y);
          for (let k = 1; k < p2.length; k++) ctx.lineTo(p2[k].x, p2[k].y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        });

      lines.forEach(line => {
        const p2 = line.pts.map(project);
        ctx.strokeStyle = line.color;
        ctx.lineWidth = Math.max(1, line.width * scale);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p2[0].x, p2[0].y);
        for (let k = 1; k < p2.length; k++) ctx.lineTo(p2[k].x, p2[k].y);
        ctx.stroke();
      });

      // Finding Badge text, just above the object
      const labelPos = project({ x: 0, y: 0, z: objTopZ });
      ctx.font = '600 10px Montserrat, sans-serif';
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(finding, labelPos.x, labelPos.y - 8);
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
    ctx.fillText(`L: ${lengthTag}${length} m`, midLen.x, midLen.y - 4);

    // Width annotation along top side edge (top2D[1] to top2D[2])
    const midWid = { x: (top2D[1].x + top2D[2].x) / 2, y: (top2D[1].y + top2D[2].y) / 2 };
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`W: ${widthTag}${width} m`, midWid.x + 6, midWid.y);

    // Depth ruler on the front-left corner (top2D[0] to btm2D[0])
    const midDep = { x: (top2D[0].x + btm2D[0].x) / 2, y: (top2D[0].y + btm2D[0].y) / 2 };
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`D: ${depthTag}${actualDepth} m`, midDep.x - 6, midDep.y);

    ctx.restore();
    ctx.restore();
  }, [length, width, actualDepth, lengthTag, widthTag, depthTag, evaluatedDepth, isSohleClear, finding, azimuth, elevation, zoom, t]);

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
