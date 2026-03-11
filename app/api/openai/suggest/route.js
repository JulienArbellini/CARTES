import OpenAI from 'openai';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function cleanRules(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }

  const out = [];
  const seen = new Set();

  for (const row of rules) {
    const source = String(row?.source ?? '').trim();
    const target = String(row?.target ?? '').trim();
    if (!source || !target) {
      continue;
    }

    const key = `${source}__${target}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push({ source, target });
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
    const superRegionCount = Number(body?.superRegionCount || 4);

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
      'You are a geospatial assistant.',
      'Goal: group administrative regions into super-regions.',
      'Return STRICT JSON only, no markdown.',
      'Output format:',
      '{',
      '  "rules": [{"source":"RegionName","target":"SuperRegionName"}],',
      '  "group_names": ["SuperRegionName1", "SuperRegionName2"],',
      '  "notes": "short rationale"',
      '}',
      'Rules:',
      '- Include only source regions that appear in the input list.',
      '- Use each source at most once.',
      '- Choose human-readable target names.',
      '- Prefer meaningful travel/business-friendly names if style requests it.',
      '- Return a complete assignment for all source regions when possible.'
    ].join('\n');

    const userPrompt = [
      `Style: ${style}`,
      `Desired super-region count: ${superRegionCount}`,
      'Source regions (exact labels):',
      JSON.stringify(regions)
    ].join('\n\n');

    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    });

    const text = responseToText(response);
    const parsed = extractJsonObject(text);

    const rules = cleanRules(parsed?.rules);

    if (rules.length === 0) {
      return NextResponse.json(
        { error: 'OpenAI returned no usable rules. Try another style or lower group count.' },
        { status: 502 }
      );
    }

    return NextResponse.json({
      rules,
      groupNames: Array.isArray(parsed?.group_names)
        ? parsed.group_names.map((x) => String(x)).filter(Boolean)
        : [],
      notes: String(parsed?.notes || '').trim()
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unexpected server error while suggesting regions.' },
      { status: 500 }
    );
  }
}
