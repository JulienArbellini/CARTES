#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');
const { parse } = require('csv-parse/sync');

function normalizeLabel(value) {
  const text = String(value ?? '').trim();
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/build_super_regions.js --input <file.geojson> --mapping <file.json|file.csv> --output <file.geojson> [options]

Options:
  --source-field <name>            Input property field used for mapping keys (default: NAME_1)
  --target-field <name>            Output group field (default: macro_region)
  --mapping-source-column <name>   Source column for CSV/JSON-list mapping (default: source)
  --mapping-target-column <name>   Target column for CSV/JSON-list mapping (default: target)
  --normalize                      Normalize labels before matching
  --on-missing <mode>              error | drop | keep-source (default: keep-source)
  --help                           Show this help message`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadCsvMapping(filePath, sourceColumn, targetColumn) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('CSV mapping is empty.');
  }

  const sample = records[0];
  if (!(sourceColumn in sample) || !(targetColumn in sample)) {
    throw new Error(`CSV mapping must contain columns '${sourceColumn}' and '${targetColumn}'.`);
  }

  const mapping = {};
  for (const row of records) {
    const source = String(row[sourceColumn] ?? '').trim();
    const target = String(row[targetColumn] ?? '').trim();
    if (!source) {
      continue;
    }
    mapping[source] = target;
  }

  if (Object.keys(mapping).length === 0) {
    throw new Error('Mapping file is empty.');
  }

  return mapping;
}

function loadMapping(filePath, sourceColumn, targetColumn, useNormalization) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Mapping file not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  let rawMapping = {};

  if (ext === '.json') {
    const data = readJsonFile(filePath);
    if (Array.isArray(data)) {
      for (const row of data) {
        if (!row || typeof row !== 'object') {
          throw new Error('JSON list mapping must contain objects.');
        }
        if (!(sourceColumn in row) || !(targetColumn in row)) {
          throw new Error(`JSON list mapping rows must contain '${sourceColumn}' and '${targetColumn}'.`);
        }
        rawMapping[String(row[sourceColumn])] = String(row[targetColumn]);
      }
    } else if (data && typeof data === 'object') {
      const entries = Object.entries(data);
      const usesCompactGroups = entries.some(([, value]) => Array.isArray(value));

      if (usesCompactGroups) {
        // Compact format:
        // {
        //   "North": ["ChiangMai", "ChiangRai"],
        //   "Central": ["Bangkok"]
        // }
        for (const [targetGroup, sourceList] of entries) {
          if (!Array.isArray(sourceList)) {
            throw new Error(
              'Mixed JSON mapping object is not supported. Use either {"source":"target"} ' +
              'or {"target":["source1","source2"]}.'
            );
          }

          for (const sourceName of sourceList) {
            const sourceKey = String(sourceName);
            if (sourceKey in rawMapping && rawMapping[sourceKey] !== String(targetGroup)) {
              throw new Error(
                `Conflicting JSON group mapping for source '${sourceKey}': ` +
                `'${rawMapping[sourceKey]}' vs '${targetGroup}'.`
              );
            }
            rawMapping[sourceKey] = String(targetGroup);
          }
        }
      } else {
        rawMapping = Object.fromEntries(
          entries.map(([k, v]) => [String(k), String(v)])
        );
      }
    } else {
      throw new Error('Unsupported JSON mapping format.');
    }
  } else if (ext === '.csv') {
    rawMapping = loadCsvMapping(filePath, sourceColumn, targetColumn);
  } else {
    throw new Error('Mapping file must be .json or .csv');
  }

  if (Object.keys(rawMapping).length === 0) {
    throw new Error('Mapping file is empty.');
  }

  if (!useNormalization) {
    return rawMapping;
  }

  const normalized = {};
  for (const [key, value] of Object.entries(rawMapping)) {
    const normKey = normalizeLabel(key);
    if (normKey in normalized && normalized[normKey] !== value) {
      throw new Error(`Conflicting mapping after normalization for key '${key}' -> '${normKey}'.`);
    }
    normalized[normKey] = value;
  }

  return normalized;
}

function ensureFeatureCollection(data) {
  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Input GeoJSON must be a FeatureCollection.');
  }
}

function dissolveGroup(features) {
  const sourceArea = features.reduce((sum, feature) => {
    try {
      return sum + turf.area(feature);
    } catch (err) {
      return sum;
    }
  }, 0);

  const isReasonableGeometry = (geometry) => {
    try {
      const outputArea = turf.area(turf.feature(geometry));
      if (!Number.isFinite(outputArea) || outputArea <= 0) {
        return false;
      }

      if (sourceArea > 0 && outputArea > sourceArea * 1.35) {
        return false;
      }

      return true;
    } catch (err) {
      return false;
    }
  };

  if (features.length === 1) {
    return features[0].geometry;
  }

  try {
    const dissolved = turf.dissolve(turf.featureCollection(features));
    if (dissolved && Array.isArray(dissolved.features) && dissolved.features[0]?.geometry) {
      const geometry = dissolved.features[0].geometry;
      if (isReasonableGeometry(geometry)) {
        return geometry;
      }
    }
  } catch (err) {
    // fallback below
  }

  let merged = turf.feature(features[0].geometry);
  for (let i = 1; i < features.length; i += 1) {
    const next = turf.feature(features[i].geometry);
    let unioned = null;

    try {
      unioned = turf.union(merged, next);
    } catch (err) {
      unioned = null;
    }

    if (!unioned) {
      const combined = turf.combine(turf.featureCollection([merged, next]));
      unioned = combined.features[0];
    }

    merged = unioned;
  }

  if (merged?.geometry && isReasonableGeometry(merged.geometry)) {
    return merged.geometry;
  }

  const combined = turf.combine(turf.featureCollection(features));
  if (combined?.features?.[0]?.geometry) {
    return combined.features[0].geometry;
  }

  return features[0].geometry;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const inputPath = args.input;
  const mappingPath = args.mapping;
  const outputPath = args.output;

  if (!inputPath || !mappingPath || !outputPath) {
    printHelp();
    throw new Error('Missing required arguments: --input, --mapping, --output');
  }

  const sourceField = args['source-field'] || 'NAME_1';
  const targetField = args['target-field'] || 'macro_region';
  const mappingSourceColumn = args['mapping-source-column'] || 'source';
  const mappingTargetColumn = args['mapping-target-column'] || 'target';
  const useNormalization = Boolean(args.normalize);
  const onMissing = args['on-missing'] || 'keep-source';

  if (!['error', 'drop', 'keep-source'].includes(onMissing)) {
    throw new Error("--on-missing must be one of: error, drop, keep-source");
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const mapping = loadMapping(mappingPath, mappingSourceColumn, mappingTargetColumn, useNormalization);
  const geojson = readJsonFile(inputPath);
  ensureFeatureCollection(geojson);

  const missingValues = new Set();
  const selectedFeatures = [];

  for (const feature of geojson.features) {
    const properties = feature && feature.properties ? feature.properties : {};
    const sourceValue = properties[sourceField];

    if (sourceValue === undefined || sourceValue === null) {
      missingValues.add(String(sourceValue));
      continue;
    }

    const sourceString = String(sourceValue);
    const sourceKey = useNormalization ? normalizeLabel(sourceString) : sourceString;
    let targetValue = mapping[sourceKey];

    if (targetValue === undefined || targetValue === null || targetValue === '') {
      missingValues.add(sourceString);

      if (onMissing === 'drop') {
        continue;
      }
      if (onMissing === 'keep-source') {
        targetValue = sourceString;
      }
    }

    if (targetValue === undefined || targetValue === null || targetValue === '') {
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

  const missingList = Array.from(missingValues).sort();
  if (missingList.length > 0 && onMissing === 'error') {
    const preview = missingList.slice(0, 20).join(', ');
    const suffix = missingList.length > 20 ? ` ... (+${missingList.length - 20} more)` : '';
    throw new Error(
      `Some regions are missing in mapping. Count=${missingList.length}. Examples: ${preview}${suffix}. ` +
      'Use --on-missing drop or --on-missing keep-source if desired.'
    );
  }

  if (selectedFeatures.length === 0) {
    throw new Error('No features left to export after filtering missing mappings.');
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
  const sortedGroups = Array.from(grouped.keys()).sort((a, b) => String(a).localeCompare(String(b)));

  for (const group of sortedGroups) {
    const groupFeatures = grouped.get(group);
    const geometry = dissolveGroup(groupFeatures);
    outputFeatures.push({
      type: 'Feature',
      properties: {
        [targetField]: group
      },
      geometry
    });
  }

  const result = {
    type: 'FeatureCollection',
    features: outputFeatures
  };
  if (geojson.crs) {
    result.crs = geojson.crs;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  console.log(`Input features: ${geojson.features.length}`);
  console.log(`Output super-regions: ${outputFeatures.length}`);
  console.log(`Missing source regions: ${missingList.length}`);
  if (missingList.length > 0) {
    console.log(`Missing examples: ${missingList.slice(0, 20).join(', ')}`);
  }
  console.log(`Output written to: ${outputPath}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
