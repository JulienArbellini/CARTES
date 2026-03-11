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

function cleanRules(rules, allowedSources) {
  if (!Array.isArray(rules)) {
    return [];
  }

  const allowed = new Map();
  for (const source of allowedSources) {
    allowed.set(normalizeKey(source), source);
  }

  const out = [];
  const seenSource = new Set();

  for (const row of rules) {
    const source = String(row?.source ?? '').trim();
    const target = String(row?.target ?? '').trim();
    if (!source || !target) {
      continue;
    }

    const sourceKey = normalizeKey(source);
    const canonicalSource = allowed.get(sourceKey);
    if (!canonicalSource) {
      continue;
    }

    if (seenSource.has(sourceKey)) {
      continue;
    }

    seenSource.add(sourceKey);
    out.push({ source: canonicalSource, target });
  }

  return out;
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

    const style = String(body?.style || 'geographic');
    const countryHint = String(body?.countryHint || '').trim();

    const rawCount = body?.superRegionCount;
    const hasRequestedCount =
      rawCount !== undefined && rawCount !== null && String(rawCount).trim() !== '';
    const superRegionCount = hasRequestedCount ? Number(rawCount) : null;

    if (hasRequestedCount && (!Number.isFinite(superRegionCount) || superRegionCount < 2 || superRegionCount > 20)) {
      return NextResponse.json(
        { error: 'superRegionCount must be between 2 and 20 when provided.' },
        { status: 400 }
      );
    }

    if (regions.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 regions to suggest grouping.' }, { status: 400 });
    }

    if (regions.length > 1500) {
      return NextResponse.json(
        {
          error:
            'Too many regions for one AI request. Reduce list size or split by country first.'
        },
        { status: 400 }
      );
    }

    const client = new OpenAI({ apiKey });

    const systemPrompt = [
      'You are a geospatial analyst specialized in regional clustering.',
      'Goal: group administrative regions into coherent super-regions.',
      'Return STRICT JSON only, no markdown.',
      'Output format:',
      '{',
      '  "rules": [{"source":"RegionName","target":"SuperRegionName"}],',
      '  "group_names": ["SuperRegionName1", "SuperRegionName2"],',
      '  "chosen_count": 4,',
      '  "notes": "short rationale in one sentence"',
      '}',
      'Hard constraints:',
      '- Use ONLY source names from the provided list.',
      '- Assign each source exactly once.',
      '- Do not invent sources.',
      '- Keep group names stable and human-readable.',
      '- Avoid random or arbitrary clusters.',
      '- Prefer geographically coherent grouping.',
      '- Avoid singleton groups unless unavoidable.',
      '- If a desired count is provided, match it exactly.',
      '- If desired count is not provided, choose a natural count between 3 and 8.'
    ].join('\n');

    const userPrompt = [
      `Style: ${style}`,
      countryHint ? `Country hint: ${countryHint}` : null,
      hasRequestedCount
        ? `Desired super-region count (mandatory): ${superRegionCount}`
        : 'Desired super-region count: not specified (choose natural count 3..8)',
      'Source regions (exact labels):',
      JSON.stringify(regions)
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0
    });

    const text = responseToText(response);
    const parsed = extractJsonObject(text);

    const rules = cleanRules(parsed?.rules, regions);

    if (rules.length === 0) {
      return NextResponse.json(
        { error: 'OpenAI returned no usable rules. Try another style or lower group count.' },
        { status: 502 }
      );
    }

    const covered = new Set(rules.map((r) => normalizeKey(r.source)));
    const missingSources = regions.filter((name) => !covered.has(normalizeKey(name)));

    if (missingSources.length > 0) {
      // Keep the API resilient: fallback to source name as group for uncovered rows.
      for (const source of missingSources) {
        rules.push({ source, target: source });
      }
    }

    const returnedGroupNames = Array.isArray(parsed?.group_names)
      ? parsed.group_names.map((x) => String(x)).filter(Boolean)
      : [];

    const actualGroupNames = Array.from(new Set(rules.map((r) => r.target))).sort((a, b) =>
      a.localeCompare(b)
    );

    return NextResponse.json({
      rules,
      groupNames: returnedGroupNames.length > 0 ? returnedGroupNames : actualGroupNames,
      chosenCount: Number(parsed?.chosen_count) || actualGroupNames.length,
      notes: String(parsed?.notes || '').trim(),
      missingFilledWithSource: missingSources.length
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unexpected server error while suggesting regions.' },
      { status: 500 }
    );
  }
}
