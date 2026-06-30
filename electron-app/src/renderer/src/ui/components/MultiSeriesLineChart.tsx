import React, { useMemo, useRef, useState } from 'react';

// Portable multi-series line chart (dependency-free SVG). Data contract is generic
// "labelled axis + named series of equal-length numeric points"; the same shape is
// reusable for any "metric over time, compare series" view (engine output, parts, …).

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
  points: number[];
  visible: boolean;
}

interface Props {
  axis: string[];
  series: ChartSeries[];
  height?: number;
  /** Format a raw axis label (e.g. 'YYYY-MM-DD') for display on the X ticks/tooltip. */
  formatLabel?: (label: string) => string;
}

const VB_W = 1000;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function MultiSeriesLineChart({ axis, series, height = 340, formatLabel }: Props): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const visible = series.filter((s) => s.visible);
  const maxY = useMemo(() => {
    let m = 0;
    for (const s of visible) for (const p of s.points) if (p > m) m = p;
    return niceCeil(m);
  }, [visible]);

  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const n = axis.length;
  const xAt = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yAt = (v: number) => PAD.top + plotH - (maxY <= 0 ? 0 : (plotH * v) / maxY);

  const yTicks = 4;
  const fmt = formatLabel ?? ((l: string) => l);

  // X tick thinning: aim for ≤ ~12 labels.
  const xStep = Math.max(1, Math.ceil(n / 12));

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const xVb = ((e.clientX - rect.left) / rect.width) * VB_W;
    const i = Math.round(((xVb - PAD.left) / (plotW || 1)) * (n - 1));
    setHoverIdx(Math.min(n - 1, Math.max(0, i)));
  }

  if (n === 0 || visible.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 14 }}>
        Нет данных за выбранный период
      </div>
    );
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VB_W} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
      onMouseMove={onMove}
      onMouseLeave={() => setHoverIdx(null)}
    >
      {/* Y gridlines + labels */}
      {Array.from({ length: yTicks + 1 }, (_, t) => {
        const v = (maxY * t) / yTicks;
        const y = yAt(v);
        return (
          <g key={`y${t}`}>
            <line x1={PAD.left} y1={y} x2={VB_W - PAD.right} y2={y} stroke="#eee" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize={11} fill="#888">
              {Math.round(v)}
            </text>
          </g>
        );
      })}

      {/* X ticks */}
      {axis.map((label, i) =>
        i % xStep === 0 || i === n - 1 ? (
          <text key={`x${i}`} x={xAt(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="#888">
            {fmt(label)}
          </text>
        ) : null,
      )}

      {/* Hover guide */}
      {hoverIdx !== null && (
        <line x1={xAt(hoverIdx)} y1={PAD.top} x2={xAt(hoverIdx)} y2={PAD.top + plotH} stroke="#bbb" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}

      {/* Series polylines */}
      {visible.map((s) => (
        <polyline
          key={s.key}
          fill="none"
          stroke={s.color}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          points={s.points.map((p, i) => `${xAt(i)},${yAt(p)}`).join(' ')}
        />
      ))}

      {/* Hover dots */}
      {hoverIdx !== null &&
        visible.map((s) => (
          <circle key={`d${s.key}`} cx={xAt(hoverIdx)} cy={yAt(s.points[hoverIdx] ?? 0)} r={3.5} fill={s.color} vectorEffect="non-scaling-stroke" />
        ))}

      {/* Tooltip */}
      {hoverIdx !== null &&
        (() => {
          const rows = visible
            .map((s) => ({ name: s.name, color: s.color, v: s.points[hoverIdx] ?? 0 }))
            .filter((r) => r.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 8);
          const boxW = 190;
          const lineH = 16;
          const boxH = 22 + rows.length * lineH;
          const rawX = xAt(hoverIdx) + 10;
          const bx = rawX + boxW > VB_W ? xAt(hoverIdx) - boxW - 10 : rawX;
          return (
            <g pointerEvents="none">
              <rect x={bx} y={PAD.top} width={boxW} height={boxH} rx={4} fill="rgba(255,255,255,0.96)" stroke="#ddd" vectorEffect="non-scaling-stroke" />
              <text x={bx + 8} y={PAD.top + 15} fontSize={11} fontWeight={600} fill="#333">
                {fmt(axis[hoverIdx] ?? '')}
              </text>
              {rows.map((r, i) => (
                <g key={r.name}>
                  <rect x={bx + 8} y={PAD.top + 22 + i * lineH} width={8} height={8} fill={r.color} />
                  <text x={bx + 20} y={PAD.top + 30 + i * lineH} fontSize={11} fill="#444">
                    {r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name}
                  </text>
                  <text x={bx + boxW - 8} y={PAD.top + 30 + i * lineH} fontSize={11} textAnchor="end" fontWeight={600} fill="#333">
                    {r.v}
                  </text>
                </g>
              ))}
            </g>
          );
        })()}
    </svg>
  );
}
