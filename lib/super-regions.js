import * as turf from '@turf/turf';

export function normalizeLabel(value) {
  const text = String(value ?? '').trim();
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function dissolveGroup(features) {
  const normalizeGeometry = (geometry) => {
    try {
      const rewound = turf.rewind(turf.feature(geometry), {
        mutate: false,
        reverse: false
      });
      return rewound?.geometry || geometry;
    } catch (_) {
      return geometry;
    }
  };

  const sourceArea = features.reduce((sum, feature) => {
    try {
      return sum + turf.area(feature);
    } catch (_) {
      return sum;
    }
  }, 0);

  const isReasonableGeometry = (geometry) => {
    try {
      const outputArea = turf.area(turf.feature(geometry));
      if (!Number.isFinite(outputArea) || outputArea <= 0) {
        return false;
      }

      // A dissolved geometry should not have significantly larger area
      // than the sum of source areas.
      if (sourceArea > 0 && outputArea > sourceArea * 1.35) {
        return false;
      }

      return true;
    } catch (_) {
      return false;
    }
  };

  if (features.length === 1) {
    return normalizeGeometry(features[0].geometry);
  }

  try {
    const dissolved = turf.dissolve(turf.featureCollection(features));
    if (dissolved?.features?.[0]?.geometry) {
      const geometry = dissolved.features[0].geometry;
      if (isReasonableGeometry(geometry)) {
        return normalizeGeometry(geometry);
      }
    }
  } catch (_) {
    // fallback below
  }

  let merged = turf.feature(features[0].geometry);

  for (let i = 1; i < features.length; i += 1) {
    const next = turf.feature(features[i].geometry);
    let unioned = null;

    try {
      unioned = turf.union(merged, next);
    } catch (_) {
      unioned = null;
    }

    if (!unioned) {
      const combined = turf.combine(turf.featureCollection([merged, next]));
      unioned = combined.features[0];
    }

    merged = unioned;
  }

  if (merged?.geometry && isReasonableGeometry(merged.geometry)) {
    return normalizeGeometry(merged.geometry);
  }

  // Safety fallback: combine keeps geometry parts without risky topological merge.
  const combined = turf.combine(turf.featureCollection(features));
  if (combined?.features?.[0]?.geometry) {
    return normalizeGeometry(combined.features[0].geometry);
  }

  return normalizeGeometry(features[0].geometry);
}

function buildMapping(assignments, useNormalization) {
  const mapping = {};

  for (const row of assignments || []) {
    const source = String(row?.source ?? '').trim();
    const target = String(row?.target ?? '').trim();

    if (!source || !target) {
      continue;
    }

    const key = useNormalization ? normalizeLabel(source) : source;

    if (key in mapping && mapping[key] !== target) {
      throw new Error(`Conflit de mapping pour '${source}'.`);
    }

    mapping[key] = target;
  }

  return mapping;
}

function ensureFeatureCollection(geojson) {
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error('Le fichier doit etre un GeoJSON FeatureCollection valide.');
  }
}

export function extractRegionValues(geojson, sourceField = 'NAME_1') {
  ensureFeatureCollection(geojson);

  const values = new Set();
  for (const feature of geojson.features) {
    const value = feature?.properties?.[sourceField];
    if (value === undefined || value === null) {
      continue;
    }
    values.add(String(value));
  }

  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function bboxOverlap(a, b) {
  // [minX, minY, maxX, maxY]
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

export function buildAdjacencyGraph(geojson, sourceField = 'NAME_1') {
  ensureFeatureCollection(geojson);

  const grouped = new Map();
  for (const feature of geojson.features) {
    const source = String(feature?.properties?.[sourceField] ?? '').trim();
    if (!source) continue;
    if (!grouped.has(source)) grouped.set(source, []);
    grouped.get(source).push(feature);
  }

  const labels = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
  const graphSets = new Map();
  for (const label of labels) graphSets.set(label, new Set());

  const mergedFeatures = labels.map((label) => {
    const features = grouped.get(label) || [];
    if (features.length === 1) return features[0];
    try {
      return turf.combine(turf.featureCollection(features)).features[0];
    } catch (_) {
      // fallback: keep first part if combine fails
      return features[0];
    }
  });

  const bboxes = mergedFeatures.map((feature) => {
    try {
      return turf.bbox(feature);
    } catch (_) {
      return null;
    }
  });

  for (let i = 0; i < mergedFeatures.length; i += 1) {
    for (let j = i + 1; j < mergedFeatures.length; j += 1) {
      const boxA = bboxes[i];
      const boxB = bboxes[j];
      if (!boxA || !boxB) continue;
      if (!bboxOverlap(boxA, boxB)) continue;

      let intersects = false;
      try {
        intersects = turf.booleanIntersects(mergedFeatures[i], mergedFeatures[j]);
      } catch (_) {
        intersects = false;
      }

      if (intersects) {
        graphSets.get(labels[i]).add(labels[j]);
        graphSets.get(labels[j]).add(labels[i]);
      }
    }
  }

  const graph = {};
  for (const label of labels) {
    graph[label] = Array.from(graphSets.get(label)).sort((a, b) => a.localeCompare(b));
  }

  return graph;
}

export function extractPropertyFields(geojson) {
  ensureFeatureCollection(geojson);

  const fields = new Set();
  for (const feature of geojson.features) {
    const props = feature?.properties || {};
    for (const key of Object.keys(props)) {
      fields.add(key);
    }
  }

  return Array.from(fields).sort((a, b) => a.localeCompare(b));
}

export function buildSuperRegions({
  geojson,
  assignments,
  sourceField = 'NAME_1',
  targetField = 'macro_region',
  normalize = true,
  onMissing = 'keep-source',
  mergeMode = 'assign-only'
}) {
  ensureFeatureCollection(geojson);

  if (!['error', 'drop', 'keep-source'].includes(onMissing)) {
    throw new Error("'onMissing' doit etre: error, drop ou keep-source.");
  }

  if (!['assign-only', 'dissolve'].includes(mergeMode)) {
    throw new Error("'mergeMode' doit etre: assign-only ou dissolve.");
  }

  const mapping = buildMapping(assignments, normalize);

  const missingSet = new Set();
  const selectedFeatures = [];

  for (const feature of geojson.features) {
    const properties = feature?.properties || {};
    const sourceValue = properties[sourceField];

    if (sourceValue === undefined || sourceValue === null) {
      missingSet.add('null');
      continue;
    }

    const sourceString = String(sourceValue);
    const sourceKey = normalize ? normalizeLabel(sourceString) : sourceString;
    let targetValue = mapping[sourceKey];

    if (!targetValue) {
      missingSet.add(sourceString);

      if (onMissing === 'drop') {
        continue;
      }
      if (onMissing === 'keep-source') {
        targetValue = sourceString;
      }
    }

    if (!targetValue) {
      continue;
    }

    selectedFeatures.push({
      type: 'Feature',
      properties: {
        ...properties,
        [targetField]: String(targetValue)
      },
      geometry: feature.geometry
    });
  }

  const missingValues = Array.from(missingSet).sort((a, b) => a.localeCompare(b));

  if (missingValues.length > 0 && onMissing === 'error') {
    const preview = missingValues.slice(0, 20).join(', ');
    const suffix = missingValues.length > 20 ? ` ... (+${missingValues.length - 20} de plus)` : '';
    throw new Error(
      `Regions sans mapping (${missingValues.length}): ${preview}${suffix}. ` +
      "Passe en keep-source ou drop si tu veux continuer."
    );
  }

  if (selectedFeatures.length === 0) {
    throw new Error('Aucune feature a exporter apres application des regles.');
  }

  if (mergeMode === 'assign-only') {
    const outputFeatures = [...selectedFeatures].sort((a, b) => {
      const aTarget = String(a?.properties?.[targetField] || '');
      const bTarget = String(b?.properties?.[targetField] || '');
      if (aTarget !== bTarget) {
        return aTarget.localeCompare(bTarget);
      }

      const aSource = String(a?.properties?.[sourceField] || '');
      const bSource = String(b?.properties?.[sourceField] || '');
      return aSource.localeCompare(bSource);
    });

    const outputGeojson = {
      type: 'FeatureCollection',
      features: outputFeatures
    };

    if (geojson.crs) {
      outputGeojson.crs = geojson.crs;
    }

    return {
      outputGeojson,
      stats: {
        inputFeatures: geojson.features.length,
        outputFeatures: outputFeatures.length,
        missingCount: missingValues.length,
        missingValues
      }
    };
  }

  const grouped = new Map();

  for (const feature of selectedFeatures) {
    const group = feature.properties[targetField];
    if (!grouped.has(group)) {
      grouped.set(group, []);
    }
    grouped.get(group).push(feature);
  }

  const outputFeatures = [];
  const groupNames = Array.from(grouped.keys()).sort((a, b) => String(a).localeCompare(String(b)));

  for (const groupName of groupNames) {
    const groupFeatures = grouped.get(groupName);
    const geometry = dissolveGroup(groupFeatures);

    outputFeatures.push({
      type: 'Feature',
      properties: {
        [targetField]: groupName
      },
      geometry
    });
  }

  const outputGeojson = {
    type: 'FeatureCollection',
    features: outputFeatures
  };

  if (geojson.crs) {
    outputGeojson.crs = geojson.crs;
  }

  return {
    outputGeojson,
    stats: {
      inputFeatures: geojson.features.length,
      outputFeatures: outputFeatures.length,
      missingCount: missingValues.length,
      missingValues
    }
  };
}
