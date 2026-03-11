import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function encodePath(filePath) {
  return filePath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function sanitizePath(value) {
  const path = String(value || '').trim().replace(/^\/+/, '');

  if (!path) {
    throw new Error('Missing target path.');
  }

  if (path.includes('..')) {
    throw new Error('Invalid path.');
  }

  if (!path.toLowerCase().endsWith('.geojson') && !path.toLowerCase().endsWith('.json')) {
    throw new Error('Path must end with .geojson or .json.');
  }

  return path;
}

async function githubFetch(url, init, token) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers || {})
    },
    cache: 'no-store'
  });

  return response;
}

export async function POST(request) {
  try {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    if (!token || !owner || !repo) {
      return NextResponse.json(
        {
          error:
            'Missing env vars. Set GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO in Vercel project settings.'
        },
        { status: 500 }
      );
    }

    const body = await request.json();
    const targetPath = sanitizePath(body?.path);
    const commitMessage = String(body?.message || 'chore: publish generated geojson');
    const geojson = body?.geojson;

    if (!geojson || geojson.type !== 'FeatureCollection') {
      return NextResponse.json({ error: 'Body must include a GeoJSON FeatureCollection in `geojson`.' }, { status: 400 });
    }

    const content = JSON.stringify(geojson, null, 2) + '\n';
    const contentBase64 = Buffer.from(content, 'utf8').toString('base64');

    const encodedPath = encodePath(targetPath);
    const endpoint = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

    let existingSha;
    const getRes = await githubFetch(`${endpoint}?ref=${encodeURIComponent(branch)}`, { method: 'GET' }, token);

    if (getRes.status === 200) {
      const existing = await getRes.json();
      existingSha = existing.sha;
    } else if (getRes.status !== 404) {
      const errPayload = await getRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: errPayload?.message || 'GitHub read failed before publish.' },
        { status: 502 }
      );
    }

    const putBody = {
      message: commitMessage,
      content: contentBase64,
      branch
    };

    if (existingSha) {
      putBody.sha = existingSha;
    }

    const putRes = await githubFetch(endpoint, { method: 'PUT', body: JSON.stringify(putBody) }, token);

    if (putRes.status < 200 || putRes.status >= 300) {
      const errPayload = await putRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: errPayload?.message || 'GitHub publish failed.' },
        { status: 502 }
      );
    }

    const payload = await putRes.json();
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${targetPath}`;

    return NextResponse.json({
      ok: true,
      rawUrl,
      path: targetPath,
      branch,
      htmlUrl: payload?.content?.html_url,
      commitSha: payload?.commit?.sha
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unexpected server error while publishing.' },
      { status: 500 }
    );
  }
}
