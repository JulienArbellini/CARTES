'use client';

import { useEffect, useMemo, useState } from 'react';
import GeoPreviewMap from './components/GeoPreviewMap';
import {
  buildAdjacencyGraph,
  buildSuperRegions,
  extractPropertyFields,
  extractRegionValues,
  normalizeLabel
} from '../lib/super-regions';

const DISTINCT_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#0082c8',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#d2f53c',
  '#fabebe',
  '#008080',
  '#e6beff',
  '#aa6e28',
  '#fffac8',
  '#800000',
  '#aaffc3',
  '#808000',
  '#ffd8b1',
  '#000080',
  '#808080',
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728'
];

function generatedDistinctColor(index) {
  const hue = (index * 137.508) % 360;
  return `hsl(${Math.round(hue)} 72% 50%)`;
}

function buildGroupColorMap(names) {
  const unique = Array.from(new Set((names || []).map((x) => String(x).trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );

  const map = new Map();
  unique.forEach((name, index) => {
    const color = index < DISTINCT_COLORS.length ? DISTINCT_COLORS[index] : generatedDistinctColor(index);
    map.set(name, color);
  });

  return map;
}

function safeFilename(name) {
  return (
    String(name || 'super_regions')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'super_regions'
  );
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

function makeRule(source = '', target = '') {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return { id, source, target };
}

export default function Page() {
  const [inputGeojson, setInputGeojson] = useState(null);
  const [inputFilename, setInputFilename] = useState('');
  const [fields, setFields] = useState([]);

  const [sourceField, setSourceField] = useState('NAME_1');
  const [targetField, setTargetField] = useState('macro_region');
  const [normalize, setNormalize] = useState(true);
  const [onMissing, setOnMissing] = useState('keep-source');
  const [mergeMode, setMergeMode] = useState('assign-only');

  const [rules, setRules] = useState([makeRule('', '')]);

  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const [result, setResult] = useState(null);
  const [publishPath, setPublishPath] = useState('generated/super_regions.geojson');
  const [publishBranch, setPublishBranch] = useState('generated-geojson');
  const [commitMessage, setCommitMessage] = useState('chore: add generated super-regions geojson');
  const [publishState, setPublishState] = useState({ loading: false, error: '', data: null });

  const [selectedRegion, setSelectedRegion] = useState('');
  const [quickTarget, setQuickTarget] = useState('');

  const [aiStyle, setAiStyle] = useState('tourism-cultural');
  const [aiGroupCount, setAiGroupCount] = useState('');
  const [aiState, setAiState] = useState({
    loading: false,
    error: '',
    notes: '',
    groupNames: [],
    chosenCount: null
  });

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

  const adjacencyGraph = useMemo(() => {
    if (!inputGeojson) return null;
    try {
      return buildAdjacencyGraph(inputGeojson, sourceField);
    } catch (_) {
      return null;
    }
  }, [inputGeojson, sourceField]);

  const countryHint = useMemo(() => {
    if (!inputGeojson?.features || !Array.isArray(inputGeojson.features)) {
      return '';
    }

    const counts = new Map();
    for (const feature of inputGeojson.features) {
      const value = String(feature?.properties?.COUNTRY || '').trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }

    let best = '';
    let bestCount = 0;
    for (const [name, count] of counts.entries()) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }

    return best;
  }, [inputGeojson]);

  const assignmentLookup = useMemo(() => {
    const map = new Map();

    for (const row of rules) {
      const source = String(row.source || '').trim();
      const target = String(row.target || '').trim();
      if (!source || !target) continue;

      const key = normalize ? normalizeLabel(source) : source;
      map.set(key, target);
    }

    return map;
  }, [rules, normalize]);

  const groupedLegend = useMemo(() => {
    const names = new Set();

    for (const row of rules) {
      const target = String(row.target || '').trim();
      if (target) names.add(target);
    }

    if (result?.outputGeojson?.features) {
      for (const feature of result.outputGeojson.features) {
        const target = String(feature?.properties?.[targetField] || '').trim();
        if (target) names.add(target);
      }
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [rules, result, targetField]);

  const groupColorMap = useMemo(() => buildGroupColorMap(groupedLegend), [groupedLegend]);

  const colorForGroup = (groupName) => {
    const label = String(groupName || '').trim();
    if (!label) return '#ded6ca';
    return groupColorMap.get(label) || '#ded6ca';
  };

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
    setStatus('Lecture du fichier...');
    setResult(null);
    setAiState({ loading: false, error: '', notes: '', groupNames: [], chosenCount: null });
    setPublishState({ loading: false, error: '', data: null });

    try {
      const text = await file.text();
      const geojson = JSON.parse(text);

      if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('Le fichier doit etre un GeoJSON FeatureCollection.');
      }

      setInputGeojson(geojson);
      setInputFilename(file.name);
      setRules([makeRule('', '')]);
      setSelectedRegion('');
      setQuickTarget('');
      const base = safeFilename(file.name);
      setPublishPath(`generated/${base}_super_regions.geojson`);
      setStatus(`Charge: ${geojson.features.length} features.`);
    } catch (e) {
      setInputGeojson(null);
      setStatus('');
      setError(e.message || 'Impossible de parser le fichier.');
    }
  }

  function updateRule(id, key, value) {
    setRules((prev) => prev.map((row) => (row.id === id ? { ...row, [key]: value } : row)));
  }

  function addRule(prefillSource = '') {
    let added = false;

    setRules((prev) => {
      if (prefillSource && prev.some((row) => String(row.source).trim() === prefillSource.trim())) {
        return prev;
      }

      added = true;
      return [...prev, makeRule(prefillSource, '')];
    });
    if (!added) return;
  }

  function removeRule(id) {
    setRules((prev) => (prev.length === 1 ? prev : prev.filter((row) => row.id !== id)));
  }

  function upsertRule(source, target) {
    const sourceValue = String(source || '').trim();
    const targetValue = String(target || '').trim();

    if (!sourceValue || !targetValue) return;

    let created = false;
    setRules((prev) => {
      const idx = prev.findIndex((row) => String(row.source).trim() === sourceValue);
      if (idx !== -1) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], target: targetValue };
        return copy;
      }

      created = true;
      return [...prev, makeRule(sourceValue, targetValue)];
    });
    if (!created) return;
  }

  function buildFromAssignments(assignments) {
    if (!inputGeojson) {
      setError('Importe un GeoJSON avant de generer.');
      return null;
    }

    setError('');
    setPublishState({ loading: false, error: '', data: null });

    try {
      const built = buildSuperRegions({
        geojson: inputGeojson,
        assignments,
        sourceField,
        targetField,
        normalize,
        onMissing,
        mergeMode
      });

      setResult(built);
      setStatus(`OK: ${built.stats.outputFeatures} super-regions generees.`);
      return built;
    } catch (e) {
      setResult(null);
      setError(e.message || 'Generation en erreur.');
      return null;
    }
  }

  function runBuild() {
    buildFromAssignments(rules);
  }

  async function suggestWithOpenAI() {
    if (!inputGeojson) {
      setError('Importe un GeoJSON avant de lancer OpenAI.');
      return;
    }

    setAiState((prev) => ({
      ...prev,
      loading: true,
      error: ''
    }));
    setError('');

    try {
      const normalizedCount = String(aiGroupCount).trim();
      const response = await fetch('/api/openai/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          regions,
          style: aiStyle,
          superRegionCount: normalizedCount === '' ? null : Number(normalizedCount),
          countryHint,
          adjacencyGraph
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'OpenAI suggestion failed.');
      }

      const generated = Array.isArray(data.rules) ? data.rules : [];
      if (generated.length === 0) {
        throw new Error('OpenAI n\'a renvoye aucune regle exploitable.');
      }

      const next = generated.map((row, index) => ({
        id: makeRule().id,
        source: String(row.source || ''),
        target: String(row.target || '')
      }));

      setRules(next);
      buildFromAssignments(next);
      setAiState({
        loading: false,
        error: '',
        notes: String(data.notes || '').trim(),
        groupNames: Array.isArray(data.groupNames) ? data.groupNames : [],
        chosenCount: Number(data.chosenCount) || null
      });
      setStatus(`OpenAI: ${next.length} regles suggerees.`);
    } catch (e) {
      setAiState({
        loading: false,
        error: e.message || 'OpenAI suggestion failed.',
        notes: '',
        groupNames: [],
        chosenCount: null
      });
    }
  }

  async function publishToGithub() {
    if (!result?.outputGeojson) {
      setError('Genere un resultat avant publication GitHub.');
      return;
    }

    setPublishState({ loading: true, error: '', data: null });

    try {
      const response = await fetch('/api/github/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: publishPath,
          branch: publishBranch,
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

  const sourceMapGetLabel = (geo) => String(geo?.properties?.[sourceField] || '');
  const sourceMapGetFill = (geo) => {
    const label = String(geo?.properties?.[sourceField] || '').trim();
    const key = normalize ? normalizeLabel(label) : label;
    const group = assignmentLookup.get(key);
    return group ? colorForGroup(group) : '#e6ddd1';
  };

  const outputMapGetLabel = (geo) => String(geo?.properties?.[targetField] || '');
  const outputMapGetFill = (geo) => {
    const group = String(geo?.properties?.[targetField] || '').trim();
    return colorForGroup(group);
  };

  return (
    <main className="page">
      <div className="hero">
        <p className="eyebrow">CARTES</p>
        <h1>Super-region builder</h1>
        <p>
          Upload GeoJSON, fais quelques assignations, previsualise la carte puis publie vers GitHub pour recuperer le lien raw.
        </p>
      </div>

      <section className="card">
        <h2>1. Import du GeoJSON</h2>
        <label className="file-input">
          <span>Fichier .json/.geojson</span>
          <input
            type="file"
            accept=".json,.geojson,application/json"
            onChange={(e) => onUploadFile(e.target.files?.[0])}
          />
        </label>

        <div className="stats-grid">
          <div>
            <small>Fichier</small>
            <strong>{inputFilename || '-'}</strong>
          </div>
          <div>
            <small>Regions detectees</small>
            <strong>{regions.length}</strong>
          </div>
          <div>
            <small>Regles actives</small>
            <strong>{assignedCount}</strong>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>2. Auto-suggestion OpenAI</h2>
        <p className="hint">
          OpenAI peut proposer automatiquement les super-regions. Tu peux ensuite corriger manuellement.
        </p>

        <div className="inline-grid">
          <label>
            <span>Style</span>
            <select value={aiStyle} onChange={(e) => setAiStyle(e.target.value)}>
              <option value="tourism-cultural">Tourisme culturel</option>
              <option value="tourism-activities">Tourisme activités</option>
              <option value="geographic">Geographique classique</option>
              <option value="business">Business / UX</option>
            </select>
          </label>

          <label>
            <span>Nombre cible de super-regions (optionnel)</span>
            <input
              type="number"
              min="2"
              max="12"
              value={aiGroupCount}
              onChange={(e) => setAiGroupCount(e.target.value)}
              placeholder="Vide = choix automatique"
            />
          </label>
        </div>

        <div className="actions">
          <button type="button" onClick={suggestWithOpenAI} disabled={aiState.loading || !inputGeojson}>
            {aiState.loading ? 'Suggestion en cours...' : 'Generer les regles avec OpenAI'}
          </button>
        </div>

        {aiState.notes ? <p className="hint">Note IA: {aiState.notes}</p> : null}
        {aiState.chosenCount ? (
          <p className="hint">Nombre de super-regions retenu: {aiState.chosenCount}</p>
        ) : null}
        {aiState.groupNames?.length > 0 ? (
          <div className="legend">
            {aiState.groupNames.map((name) => (
              <span key={name} className="legend-item">
                <i style={{ background: colorForGroup(name) }} />
                {name}
              </span>
            ))}
          </div>
        ) : null}
        {adjacencyGraph ? (
          <p className="hint">
            Graphe de contiguite actif ({Object.keys(adjacencyGraph).length} regions).
          </p>
        ) : null}
        {aiState.error ? <p className="error">{aiState.error}</p> : null}
      </section>

      <section className="card">
        <h2>3. Regles manuelles (simple)</h2>
        <p className="hint">
          Garde seulement les lignes utiles. Les regions non listees restent inchangees par defaut.
        </p>

        <div className="inline-grid">
          <label>
            <span>Champ source</span>
            <select value={sourceField} onChange={(e) => setSourceField(e.target.value)}>
              {fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Champ cible</span>
            <input
              type="text"
              value={targetField}
              onChange={(e) => setTargetField(e.target.value)}
              placeholder="macro_region"
            />
          </label>

          <label>
            <span>Si region absente des regles</span>
            <select value={onMissing} onChange={(e) => setOnMissing(e.target.value)}>
              <option value="keep-source">keep-source</option>
              <option value="error">error</option>
              <option value="drop">drop</option>
            </select>
          </label>

          <label>
            <span>Mode de sortie</span>
            <select value={mergeMode} onChange={(e) => setMergeMode(e.target.value)}>
              <option value="assign-only">assign-only (recommande)</option>
              <option value="dissolve">dissolve (fusion geometrique)</option>
            </select>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={normalize}
              onChange={(e) => setNormalize(e.target.checked)}
            />
            <span>Normaliser les labels</span>
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
                placeholder="Region source"
              />
              <input
                value={row.target}
                onChange={(e) => updateRule(row.id, 'target', e.target.value)}
                placeholder="Super-region"
              />
              <button type="button" className="ghost" onClick={() => removeRule(row.id)}>
                Supprimer
              </button>
            </div>
          ))}
        </div>

        <div className="actions">
          <button type="button" className="ghost" onClick={() => addRule()}>
            + Ajouter ligne
          </button>
          <button type="button" onClick={runBuild}>
            Generer super-regions
          </button>
        </div>
      </section>

      <section className="card">
        <h2>4. Preview carte interactive</h2>
        <p className="hint">Clique une region dans la carte source pour la pre-remplir dans les regles.</p>

        <div className="map-grid">
          <GeoPreviewMap
            title="Carte source"
            subtitle="Couleur = super-region assignee"
            geojson={inputGeojson}
            getLabel={sourceMapGetLabel}
            getFill={sourceMapGetFill}
            onRegionClick={(label) => {
              setSelectedRegion(label);
              addRule(label);
            }}
            selectedLabel={selectedRegion}
          />

          <GeoPreviewMap
            title="Resultat genere"
            subtitle="Preview avant publication"
            geojson={result?.outputGeojson || null}
            getLabel={outputMapGetLabel}
            getFill={outputMapGetFill}
          />
        </div>

        <div className="inline-grid quick-grid">
          <label>
            <span>Region selectionnee (depuis carte)</span>
            <input
              value={selectedRegion}
              onChange={(e) => setSelectedRegion(e.target.value)}
              placeholder="Clique une region dans la carte"
            />
          </label>
          <label>
            <span>Assigner a</span>
            <input
              value={quickTarget}
              onChange={(e) => setQuickTarget(e.target.value)}
              placeholder="Ex: North"
            />
          </label>
        </div>

        <div className="actions">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              upsertRule(selectedRegion, quickTarget);
              setQuickTarget('');
            }}
            disabled={!selectedRegion || !quickTarget}
          >
            Assigner la region selectionnee
          </button>
        </div>

        {groupedLegend.length > 0 ? (
          <div className="legend">
            {groupedLegend.map((name) => (
              <span key={name} className="legend-item">
                <i style={{ background: colorForGroup(name) }} />
                {name}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>5. Export</h2>
        {result ? (
          <>
            <div className="stats-grid">
              <div>
                <small>Features entree</small>
                <strong>{result.stats.inputFeatures}</strong>
              </div>
              <div>
                <small>Features sortie</small>
                <strong>{result.stats.outputFeatures}</strong>
              </div>
              <div>
                <small>Regions non mappees</small>
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
                Telecharger le GeoJSON genere
              </button>
            </div>
          </>
        ) : (
          <p className="hint">Genere d'abord un resultat.</p>
        )}
      </section>

      <section className="card">
        <h2>6. Publish GitHub + URL raw</h2>
        <p className="hint">Le token GitHub reste cote serveur (route API), jamais expose dans le front.</p>

        <div className="inline-grid">
          <label>
            <span>Chemin dans le repo</span>
            <input
              type="text"
              value={publishPath}
              onChange={(e) => setPublishPath(e.target.value)}
              placeholder="generated/thailand_super_regions.geojson"
            />
          </label>

          <label>
            <span>Branche de publication</span>
            <input
              type="text"
              value={publishBranch}
              onChange={(e) => setPublishBranch(e.target.value)}
              placeholder="generated-geojson"
            />
          </label>

          <label>
            <span>Message de commit</span>
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
            />
          </label>
        </div>

        <div className="actions">
          <button type="button" onClick={publishToGithub} disabled={publishState.loading || !result}>
            {publishState.loading ? 'Publication en cours...' : 'Publier et recuperer URL raw'}
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
