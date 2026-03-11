'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  buildSuperRegions,
  extractPropertyFields,
  extractRegionValues
} from '../lib/super-regions';

function safeFilename(name) {
  return String(name || 'super_regions')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'super_regions';
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Page() {
  const [inputGeojson, setInputGeojson] = useState(null);
  const [inputFilename, setInputFilename] = useState('');
  const [fields, setFields] = useState([]);

  const [sourceField, setSourceField] = useState('NAME_1');
  const [targetField, setTargetField] = useState('macro_region');
  const [normalize, setNormalize] = useState(true);
  const [onMissing, setOnMissing] = useState('keep-source');

  const [rules, setRules] = useState([{ id: 1, source: '', target: '' }]);
  const [nextRuleId, setNextRuleId] = useState(2);

  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const [result, setResult] = useState(null);
  const [publishPath, setPublishPath] = useState('generated/super_regions.geojson');
  const [commitMessage, setCommitMessage] = useState('chore: add generated super-regions geojson');
  const [publishState, setPublishState] = useState({ loading: false, error: '', data: null });

  const regions = useMemo(() => {
    if (!inputGeojson) return [];
    try {
      return extractRegionValues(inputGeojson, sourceField);
    } catch (_) {
      return [];
    }
  }, [inputGeojson, sourceField]);

  const assignedCount = useMemo(
    () => rules.filter((row) => String(row.source).trim() && String(row.target).trim()).length,
    [rules]
  );

  useEffect(() => {
    if (!inputGeojson) return;

    try {
      const nextFields = extractPropertyFields(inputGeojson);
      setFields(nextFields);

      if (!nextFields.includes(sourceField)) {
        if (nextFields.includes('NAME_1')) {
          setSourceField('NAME_1');
        } else if (nextFields.length > 0) {
          setSourceField(nextFields[0]);
        }
      }
    } catch (e) {
      setError(e.message || 'Unable to read properties.');
    }
  }, [inputGeojson, sourceField]);

  async function onUploadFile(file) {
    if (!file) return;

    setError('');
    setStatus('Reading file...');
    setResult(null);
    setPublishState({ loading: false, error: '', data: null });

    try {
      const text = await file.text();
      const geojson = JSON.parse(text);

      if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('File must be a GeoJSON FeatureCollection.');
      }

      setInputGeojson(geojson);
      setInputFilename(file.name);
      const base = safeFilename(file.name);
      setPublishPath(`generated/${base}_super_regions.geojson`);
      setStatus(`Loaded ${geojson.features.length} features.`);
    } catch (e) {
      setInputGeojson(null);
      setStatus('');
      setError(e.message || 'Unable to parse file.');
    }
  }

  function updateRule(id, key, value) {
    setRules((prev) => prev.map((row) => (row.id === id ? { ...row, [key]: value } : row)));
  }

  function addRule(prefillSource = '') {
    setRules((prev) => [...prev, { id: nextRuleId, source: prefillSource, target: '' }]);
    setNextRuleId((prev) => prev + 1);
  }

  function removeRule(id) {
    setRules((prev) => (prev.length === 1 ? prev : prev.filter((row) => row.id !== id)));
  }

  function runBuild() {
    if (!inputGeojson) {
      setError('Import a GeoJSON file first.');
      return;
    }

    setError('');
    setPublishState({ loading: false, error: '', data: null });

    try {
      const built = buildSuperRegions({
        geojson: inputGeojson,
        assignments: rules,
        sourceField,
        targetField,
        normalize,
        onMissing
      });

      setResult(built);
      setStatus(`Done: ${built.stats.outputFeatures} super-regions generated.`);
    } catch (e) {
      setResult(null);
      setError(e.message || 'Build failed.');
    }
  }

  async function publishToGithub() {
    if (!result?.outputGeojson) {
      setError('Generate a result before publishing.');
      return;
    }

    setPublishState({ loading: true, error: '', data: null });

    try {
      const response = await fetch('/api/github/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: publishPath,
          message: commitMessage,
          geojson: result.outputGeojson
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Publish failed.');
      }

      setPublishState({ loading: false, error: '', data });
    } catch (e) {
      setPublishState({ loading: false, error: e.message || 'Publish failed.', data: null });
    }
  }

  return (
    <main className="page">
      <div className="hero">
        <p className="eyebrow">CARTES</p>
        <h1>Super-region builder</h1>
        <p>
          Upload a GeoJSON, assign only the regions you want, generate the merged GeoJSON,
          then publish it to GitHub and copy the raw URL.
        </p>
      </div>

      <section className="card">
        <h2>1. Import</h2>
        <label className="file-input">
          <span>GeoJSON file</span>
          <input
            type="file"
            accept=".json,.geojson,application/json"
            onChange={(e) => onUploadFile(e.target.files?.[0])}
          />
        </label>
        <div className="stats-grid">
          <div>
            <small>File</small>
            <strong>{inputFilename || '-'}</strong>
          </div>
          <div>
            <small>Regions found</small>
            <strong>{regions.length}</strong>
          </div>
          <div>
            <small>Assignments</small>
            <strong>{assignedCount}</strong>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>2. Assign only what you need</h2>
        <p className="hint">
          Add only a few source regions. Unassigned regions are kept as-is by default.
        </p>

        <div className="inline-grid">
          <label>
            <span>Source field</span>
            <select value={sourceField} onChange={(e) => setSourceField(e.target.value)}>
              {fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Target field</span>
            <input
              type="text"
              value={targetField}
              onChange={(e) => setTargetField(e.target.value)}
              placeholder="macro_region"
            />
          </label>
          <label>
            <span>On missing</span>
            <select value={onMissing} onChange={(e) => setOnMissing(e.target.value)}>
              <option value="keep-source">keep-source</option>
              <option value="error">error</option>
              <option value="drop">drop</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={normalize}
              onChange={(e) => setNormalize(e.target.checked)}
            />
            <span>Normalize labels (accents/spaces)</span>
          </label>
        </div>

        <datalist id="region-options">
          {regions.map((region) => (
            <option key={region} value={region} />
          ))}
        </datalist>

        <div className="rules">
          {rules.map((row) => (
            <div key={row.id} className="rule-row">
              <input
                list="region-options"
                value={row.source}
                onChange={(e) => updateRule(row.id, 'source', e.target.value)}
                placeholder="Source region (e.g. ChiangMai)"
              />
              <input
                value={row.target}
                onChange={(e) => updateRule(row.id, 'target', e.target.value)}
                placeholder="Super region (e.g. North)"
              />
              <button type="button" className="ghost" onClick={() => removeRule(row.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="actions">
          <button type="button" className="ghost" onClick={() => addRule()}>
            + Add line
          </button>
          <button type="button" onClick={runBuild}>
            Generate super-regions
          </button>
        </div>
      </section>

      <section className="card">
        <h2>3. Export</h2>

        {result ? (
          <>
            <div className="stats-grid">
              <div>
                <small>Input features</small>
                <strong>{result.stats.inputFeatures}</strong>
              </div>
              <div>
                <small>Output features</small>
                <strong>{result.stats.outputFeatures}</strong>
              </div>
              <div>
                <small>Unmapped source regions</small>
                <strong>{result.stats.missingCount}</strong>
              </div>
            </div>

            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  downloadJson(
                    result.outputGeojson,
                    `${safeFilename(inputFilename || 'super_regions')}_output.geojson`
                  )
                }
              >
                Download output GeoJSON
              </button>
            </div>
          </>
        ) : (
          <p className="hint">Generate first to get an export file.</p>
        )}
      </section>

      <section className="card">
        <h2>4. Publish to GitHub</h2>
        <p className="hint">
          This uses a secure server API route with your Vercel environment variables.
        </p>

        <div className="inline-grid">
          <label>
            <span>Repository path</span>
            <input
              type="text"
              value={publishPath}
              onChange={(e) => setPublishPath(e.target.value)}
              placeholder="generated/thailand_super_regions.geojson"
            />
          </label>
          <label>
            <span>Commit message</span>
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
            />
          </label>
        </div>

        <div className="actions">
          <button type="button" onClick={publishToGithub} disabled={publishState.loading || !result}>
            {publishState.loading ? 'Publishing...' : 'Publish and get raw URL'}
          </button>
        </div>

        {publishState.error ? <p className="error">{publishState.error}</p> : null}
        {publishState.data ? (
          <div className="result-box">
            <p>
              <strong>Raw URL:</strong>
            </p>
            <a href={publishState.data.rawUrl} target="_blank" rel="noreferrer">
              {publishState.data.rawUrl}
            </a>
          </div>
        ) : null}
      </section>

      {status ? <p className="status">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
