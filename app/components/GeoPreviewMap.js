'use client';

import { useMemo, useState } from 'react';
import { geoMercator, geoPath } from 'd3-geo';

function defaultColor() {
  return '#e6ddd1';
}

function withAlpha(hex, alpha) {
  const value = String(hex || '').replace('#', '').trim();
  if (value.length !== 6) {
    return hex;
  }

  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function GeoPreviewMap({
  title,
  subtitle,
  geojson,
  getLabel,
  getFill,
  onRegionClick,
  selectedLabel
}) {
  const [hoverLabel, setHoverLabel] = useState('');

  const width = 860;
  const height = 420;

  const { paths, featureCount } = useMemo(() => {
    if (!geojson?.features || !Array.isArray(geojson.features) || geojson.features.length === 0) {
      return { paths: [], featureCount: 0 };
    }

    const projection = geoMercator();
    projection.fitSize([width, height], geojson);

    const pathGenerator = geoPath(projection);

    const pathRows = geojson.features
      .map((feature, index) => {
        const d = pathGenerator(feature);
        if (!d) return null;

        const label = String(getLabel?.({ properties: feature.properties, index }) || 'unknown');
        const baseFill = getFill?.({ properties: feature.properties, index }) || defaultColor();
        const isSelected = selectedLabel && label === selectedLabel;

        return {
          key: feature?.id || `${label}-${index}`,
          d,
          label,
          fill: isSelected ? withAlpha(baseFill, 0.75) : baseFill,
          isSelected
        };
      })
      .filter(Boolean);

    return {
      paths: pathRows,
      featureCount: geojson.features.length
    };
  }, [geojson, getLabel, getFill, selectedLabel]);

  if (!geojson) {
    return (
      <div className="map-card empty">
        <div>
          <h3>{title}</h3>
          <p className="hint">No data yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="map-card">
      <div className="map-head">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p className="hint">{subtitle}</p> : null}
        </div>
        <p className="tiny">{featureCount} features</p>
      </div>

      <div className="map-body">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img">
          <rect x="0" y="0" width={width} height={height} fill="#fffdf8" />
          <g>
            {paths.map((row) => (
              <path
                key={row.key}
                d={row.d}
                fill={row.fill}
                fillRule="evenodd"
                clipRule="evenodd"
                stroke={row.isSelected ? '#3f3a33' : '#6e655a'}
                strokeWidth={row.isSelected ? 1 : 0.45}
                onMouseEnter={() => setHoverLabel(row.label)}
                onMouseLeave={() => setHoverLabel('')}
                onClick={() => onRegionClick?.(row.label)}
                style={{ cursor: onRegionClick ? 'pointer' : 'default' }}
              />
            ))}
          </g>
        </svg>
      </div>

      <div className="map-foot">
        <span>{hoverLabel || 'Survole une region'}</span>
        {onRegionClick ? <small>Clique pour ajouter/modifier une regle</small> : null}
      </div>
    </div>
  );
}
