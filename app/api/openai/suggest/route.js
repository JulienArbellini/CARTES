import OpenAI from 'openai';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function normalizeKey(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractJsonObject(text) {
  if (!text) {
    throw new Error('Empty model output.');
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Model output is not valid JSON.');
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function responseToText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];
  const outputs = Array.isArray(response?.output) ? response.output : [];

  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      const value = block?.text ?? block?.output_text ?? '';
      if (typeof value === 'string' && value.trim()) {
        chunks.push(value.trim());
      }
    }
  }

  return chunks.join('\n').trim();
}

function buildCanonicalRegionMap(regions) {
  const map = new Map();
  for (const region of regions) {
    map.set(normalizeKey(region), region);
  }
  return map;
}

function sanitizeAdjacencyGraph(rawGraph, regions) {
  const canonical = buildCanonicalRegionMap(regions);
  const graphSet = new Map();

  for (const region of regions) {
    graphSet.set(region, new Set());
  }

  if (!rawGraph || typeof rawGraph !== 'object' || Array.isArray(rawGraph)) {
    return Object.fromEntries(regions.map((r) => [r, []]));
  }

  for (const [rawNode, rawNeighbors] of Object.entries(rawGraph)) {
    const canonicalNode = canonical.get(normalizeKey(rawNode));
    if (!canonicalNode) continue;

    const neighbors = Array.isArray(rawNeighbors) ? rawNeighbors : [];
    for (const rawNeighbor of neighbors) {
      const canonicalNeighbor = canonical.get(normalizeKey(rawNeighbor));
      if (!canonicalNeighbor || canonicalNeighbor === canonicalNode) continue;

      graphSet.get(canonicalNode).add(canonicalNeighbor);
      graphSet.get(canonicalNeighbor).add(canonicalNode);
    }
  }

  const graph = {};
  for (const region of regions) {
    graph[region] = Array.from(graphSet.get(region)).sort((a, b) => a.localeCompare(b));
  }

  return graph;
}

function cleanRules(rules, regions) {
  if (!Array.isArray(rules)) {
    return [];
  }

  const canonical = buildCanonicalRegionMap(regions);
  const seenSources = new Set();
  const out = [];

  for (const row of rules) {
    const sourceRaw = String(row?.source ?? '').trim();
    const target = String(row?.target ?? '').trim();
    if (!sourceRaw || !target) continue;

    const canonicalSource = canonical.get(normalizeKey(sourceRaw));
    if (!canonicalSource) continue;

    const sourceKey = normalizeKey(canonicalSource);
    if (seenSources.has(sourceKey)) continue;

    seenSources.add(sourceKey);
    out.push({ source: canonicalSource, target });
  }

  return out;
}

function mostFrequentTarget(targetCounts) {
  let bestTarget = null;
  let bestCount = -1;

  for (const [target, count] of targetCounts.entries()) {
    if (count > bestCount) {
      bestTarget = target;
      bestCount = count;
    } else if (count === bestCount && bestTarget && target.localeCompare(bestTarget) < 0) {
      bestTarget = target;
    }
  }

  return bestTarget;
}

function nearestAssignedTarget(region, adjacency, bySource) {
  const visited = new Set([region]);
  let frontier = [region];

  while (frontier.length > 0) {
    const nextFrontier = [];
    const votes = new Map();

    for (const node of frontier) {
      const neighbors = Array.isArray(adjacency[node]) ? adjacency[node] : [];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        nextFrontier.push(neighbor);

        const assigned = bySource.get(neighbor);
        if (assigned?.target) {
          votes.set(assigned.target, (votes.get(assigned.target) || 0) + 1);
        }
      }
    }

    const winner = mostFrequentTarget(votes);
    if (winner) return winner;
    frontier = nextFrontier;
  }

  return null;
}

function ensureCompleteRules(rules, regions, adjacency, preferExistingTargets = true) {
  const bySource = new Map(rules.map((r) => [r.source, { source: r.source, target: r.target }]));
  const targetCounts = new Map();

  for (const rule of rules) {
    targetCounts.set(rule.target, (targetCounts.get(rule.target) || 0) + 1);
  }

  for (const region of regions) {
    if (bySource.has(region)) continue;

    let target = null;
    if (preferExistingTargets && targetCounts.size > 0) {
      target = nearestAssignedTarget(region, adjacency, bySource);
      if (!target) {
        target = mostFrequentTarget(targetCounts);
      }
    }

    if (!target) {
      target = region;
    }

    bySource.set(region, { source: region, target });
    targetCounts.set(target, (targetCounts.get(target) || 0) + 1);
  }

  return regions.map((region) => bySource.get(region));
}

function buildGroups(rules) {
  const groups = new Map();
  for (const { source, target } of rules) {
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(source);
  }
  return groups;
}

function connectedComponents(nodes, adjacency) {
  const nodeSet = new Set(nodes);
  const visited = new Set();
  const components = [];

  for (const node of nodes) {
    if (visited.has(node)) continue;

    const stack = [node];
    visited.add(node);
    const component = [];

    while (stack.length > 0) {
      const current = stack.pop();
      component.push(current);

      const neighbors = Array.isArray(adjacency[current]) ? adjacency[current] : [];
      for (const neighbor of neighbors) {
        if (!nodeSet.has(neighbor) || visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

function getContiguityViolations(rules, adjacency) {
  const groups = buildGroups(rules);
  const violations = [];

  for (const [groupName, sources] of groups.entries()) {
    const core = sources.filter((s) => (adjacency[s] || []).length > 0);
    if (core.length <= 1) continue;

    const components = connectedComponents(core, adjacency);
    if (components.length > 1) {
      violations.push({
        group: groupName,
        componentCount: components.length,
        components
      });
    }
  }

  return violations;
}

function splitDisconnectedGroups(rules, adjacency) {
  const groups = buildGroups(rules);
  const ruleBySource = new Map(rules.map((r) => [r.source, { ...r }]));
  const usedTargets = new Set(rules.map((r) => r.target));

  const uniqueTarget = (base) => {
    let idx = 2;
    let candidate = `${base} ${idx}`;
    while (usedTargets.has(candidate)) {
      idx += 1;
      candidate = `${base} ${idx}`;
    }
    usedTargets.add(candidate);
    return candidate;
  };

  for (const [groupName, sources] of groups.entries()) {
    const core = sources.filter((s) => (adjacency[s] || []).length > 0);
    if (core.length <= 1) continue;

    const components = connectedComponents(core, adjacency);
    if (components.length <= 1) continue;

    components.sort((a, b) => b.length - a.length);

    for (let i = 1; i < components.length; i += 1) {
      const newGroupName = uniqueTarget(groupName);
      for (const source of components[i]) {
        const row = ruleBySource.get(source);
        if (row) row.target = newGroupName;
      }
    }
  }

  return Array.from(ruleBySource.values());
}

function groupCount(rules) {
  return new Set(rules.map((r) => r.target)).size;
}

function mergeGroupsToRequestedCount(rules, adjacency, requestedCount) {
  if (!Number.isFinite(requestedCount)) {
    return rules;
  }

  const bySource = new Map(rules.map((r) => [r.source, { ...r }]));

  const rebuildGroups = () => {
    const groups = new Map();
    for (const row of bySource.values()) {
      if (!groups.has(row.target)) groups.set(row.target, []);
      groups.get(row.target).push(row.source);
    }
    return groups;
  };

  const groupSizes = (groups) =>
    Array.from(groups.entries()).map(([name, members]) => ({
      name,
      members,
      size: members.length
    }));

  let groups = rebuildGroups();
  while (groups.size > requestedCount) {
    const sized = groupSizes(groups).sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
    const smallest = sized[0];
    if (!smallest) break;

    const edgeVotes = new Map();
    for (const source of smallest.members) {
      const neighbors = Array.isArray(adjacency[source]) ? adjacency[source] : [];
      for (const neighbor of neighbors) {
        const nRow = bySource.get(neighbor);
        if (!nRow || nRow.target === smallest.name) continue;
        edgeVotes.set(nRow.target, (edgeVotes.get(nRow.target) || 0) + 1);
      }
    }

    let targetGroup = mostFrequentTarget(edgeVotes);
    if (!targetGroup) {
      const largestOther = sized
        .filter((g) => g.name !== smallest.name)
        .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))[0];
      targetGroup = largestOther?.name || null;
    }

    if (!targetGroup) {
      break;
    }

    for (const source of smallest.members) {
      const row = bySource.get(source);
      if (row) row.target = targetGroup;
    }

    groups = rebuildGroups();
  }

  return Array.from(bySource.values());
}

function adjacencyEdgeCount(adjacency, regions) {
  let total = 0;
  for (const region of regions) {
    total += Array.isArray(adjacency[region]) ? adjacency[region].length : 0;
  }
  return Math.floor(total / 2);
}

async function callSuggestionModel({ client, model, regions, adjacency, style, requestedCount, countryHint }) {
  const systemPrompt = [
    'You are a tourism destination strategist and geospatial clustering expert.',
    'Task: cluster administrative regions into tourism super-regions.',
    'Output STRICT JSON only (no markdown).',
    'JSON shape:',
    '{',
    '  "rules": [{"source":"RegionName","target":"SuperRegionName"}],',
    '  "group_names": ["SuperRegionName1","SuperRegionName2"],',
    '  "chosen_count": 6,',
    '  "notes": "one short sentence"',
    '}',
    'Hard constraints:',
    '- Use only source names from the provided list.',
    '- Assign each source exactly once.',
    '- Super-regions must be spatially contiguous according to adjacency graph.',
    '- Avoid arbitrary/random grouping.',
    '- Do NOT leave any region unassigned.',
    '- Do NOT create single-region fallback groups unless absolutely unavoidable.',
    '- Prioritize tourism coherence: culture, landscapes, activities, typical itineraries.',
    '- Keep names short, marketable, and understandable for travelers.',
    '- If requested_count is provided, respect it exactly.',
    '- If requested_count is null, choose a natural count between 4 and 8.'
  ].join('\n');

  const userPrompt = [
    `Style: ${style}`,
    `Country hint: ${countryHint || 'unknown'}`,
    `Requested count: ${requestedCount === null ? 'null' : requestedCount}`,
    `Regions (${regions.length}): ${JSON.stringify(regions)}`,
    `Adjacency graph: ${JSON.stringify(adjacency)}`
  ].join('\n\n');

  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0
  });

  const text = responseToText(response);
  return extractJsonObject(text);
}

async function callContiguityRepairModel({ client, model, regions, adjacency, previousRules, violations, requestedCount }) {
  const systemPrompt = [
    'You fix geographic contiguity issues in tourism region clustering.',
    'Output STRICT JSON only with full rules.',
    'Do not invent source names.',
    'Each source exactly once.',
    'All groups must be contiguous according to adjacency graph.',
    'Do not leave regions unassigned.',
    'Respect requested count when it is not null.',
    'Keep tourism meaning as much as possible.'
  ].join('\n');

  const userPrompt = [
    `Requested count: ${requestedCount === null ? 'null' : requestedCount}`,
    `Regions: ${JSON.stringify(regions)}`,
    `Adjacency graph: ${JSON.stringify(adjacency)}`,
    `Current rules: ${JSON.stringify(previousRules)}`,
    `Contiguity violations: ${JSON.stringify(violations)}`,
    'Return only corrected JSON in same format.'
  ].join('\n\n');

  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0
  });

  const text = responseToText(response);
  return extractJsonObject(text);
}

export async function POST(request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Missing OPENAI_API_KEY in environment variables.' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const regions = Array.isArray(body?.regions)
      ? body.regions.map((x) => String(x)).filter(Boolean)
      : [];

    const style = String(body?.style || 'tourism-cultural');
    const countryHint = String(body?.countryHint || '').trim();

    const rawCount = body?.superRegionCount;
    const hasRequestedCount =
      rawCount !== undefined && rawCount !== null && String(rawCount).trim() !== '';
    const requestedCount = hasRequestedCount ? Number(rawCount) : null;

    if (hasRequestedCount && (!Number.isFinite(requestedCount) || requestedCount < 2 || requestedCount > 20)) {
      return NextResponse.json(
        { error: 'superRegionCount must be between 2 and 20 when provided.' },
        { status: 400 }
      );
    }

    if (regions.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 regions to suggest grouping.' }, { status: 400 });
    }

    if (regions.length > 600) {
      return NextResponse.json(
        {
          error:
            'Too many regions for one AI request. Split the input by country/area first.'
        },
        { status: 400 }
      );
    }

    const adjacency = sanitizeAdjacencyGraph(body?.adjacencyGraph, regions);
    const edgeCount = adjacencyEdgeCount(adjacency, regions);

    const client = new OpenAI({ apiKey });

    const firstPass = await callSuggestionModel({
      client,
      model,
      regions,
      adjacency,
      style,
      requestedCount,
      countryHint
    });

    let rules = cleanRules(firstPass?.rules, regions);
    rules = ensureCompleteRules(rules, regions, adjacency, true);

    if (requestedCount !== null) {
      rules = mergeGroupsToRequestedCount(rules, adjacency, requestedCount);
      rules = ensureCompleteRules(rules, regions, adjacency, true);
    }

    let violations = edgeCount > 0 ? getContiguityViolations(rules, adjacency) : [];

    let repairedByModel = false;
    let repairedBySplit = false;

    if (violations.length > 0 && edgeCount > 0) {
      const repaired = await callContiguityRepairModel({
        client,
        model,
        regions,
        adjacency,
        previousRules: rules,
        violations,
        requestedCount
      });

      rules = cleanRules(repaired?.rules, regions);
      rules = ensureCompleteRules(rules, regions, adjacency, true);
      if (requestedCount !== null) {
        rules = mergeGroupsToRequestedCount(rules, adjacency, requestedCount);
        rules = ensureCompleteRules(rules, regions, adjacency, true);
      }
      violations = getContiguityViolations(rules, adjacency);
      repairedByModel = true;
    }

    if (violations.length > 0 && edgeCount > 0) {
      rules = splitDisconnectedGroups(rules, adjacency);
      if (requestedCount !== null) {
        rules = mergeGroupsToRequestedCount(rules, adjacency, requestedCount);
      }
      rules = ensureCompleteRules(rules, regions, adjacency, true);
      violations = getContiguityViolations(rules, adjacency);
      repairedBySplit = true;
    }

    if (requestedCount !== null && groupCount(rules) > requestedCount) {
      rules = mergeGroupsToRequestedCount(rules, adjacency, requestedCount);
      rules = ensureCompleteRules(rules, regions, adjacency, true);
      violations = edgeCount > 0 ? getContiguityViolations(rules, adjacency) : [];
    }

    const groupNames = Array.from(new Set(rules.map((r) => r.target))).sort((a, b) =>
      a.localeCompare(b)
    );

    return NextResponse.json({
      rules,
      groupNames,
      chosenCount: groupNames.length,
      notes: String(firstPass?.notes || '').trim(),
      contiguity: {
        edges: edgeCount,
        remainingViolations: violations.length,
        violations,
        repairedByModel,
        repairedBySplit,
        requestedCount
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unexpected server error while suggesting regions.' },
      { status: 500 }
    );
  }
}
