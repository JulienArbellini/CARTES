#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

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
  node scripts/init_mapping_template.js --input <file.geojson> --output <file.csv> [options]

Options:
  --source-field <name>   GeoJSON property field to extract (default: NAME_1)
  --help                  Show this help message`);
}

function escapeCsvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const inputPath = args.input;
  const outputPath = args.output;
  const sourceField = args['source-field'] || 'NAME_1';

  if (!inputPath || !outputPath) {
    printHelp();
    throw new Error('Missing required arguments: --input, --output');
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Input GeoJSON must be a FeatureCollection.');
  }

  const labels = new Set();
  for (const feature of data.features) {
    const props = feature && feature.properties ? feature.properties : {};
    const value = props[sourceField];
    if (value === undefined || value === null) {
      continue;
    }
    labels.add(String(value).trim());
  }

  if (labels.size === 0) {
    throw new Error(`No values found for source field '${sourceField}'.`);
  }

  const rows = ['source,target'];
  const sorted = Array.from(labels).sort((a, b) => a.localeCompare(b));
  for (const label of sorted) {
    rows.push(`${escapeCsvCell(label)},`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${rows.join('\n')}\n`);

  console.log(`Found ${labels.size} unique values in '${sourceField}'.`);
  console.log(`Template written to: ${outputPath}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
