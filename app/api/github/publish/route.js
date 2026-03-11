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

function sanitizeBranch(value, fallback) {
  const branch = String(value || fallback || '').trim();
  if (!branch) {
    throw new Error('Missing target branch.');
  }
  if (branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error('Invalid branch name.');
  }
  return branch;
}

function encodeBranchRef(branch) {
  return branch
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
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

async function ensureBranchExists({ token, owner, repo, branch, baseBranch }) {
  const branchRef = encodeBranchRef(branch);
  const branchUrl = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branchRef}`;

  const currentBranchRes = await githubFetch(branchUrl, { method: 'GET' }, token);
  if (currentBranchRes.status === 200) {
    return;
  }

  if (currentBranchRes.status !== 404) {
    const payload = await currentBranchRes.json().catch(() => ({}));
    throw new Error(payload?.message || 'Unable to check target branch.');
  }

  const baseRef = encodeBranchRef(baseBranch);
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${baseRef}`;
  const baseRes = await githubFetch(baseUrl, { method: 'GET' }, token);

  if (baseRes.status !== 200) {
    const payload = await baseRes.json().catch(() => ({}));
    throw new Error(payload?.message || `Base branch '${baseBranch}' not found.`);
  }

  const basePayload = await baseRes.json();
  const baseSha = basePayload?.object?.sha;
  if (!baseSha) {
    throw new Error(`Unable to resolve SHA for base branch '${baseBranch}'.`);
  }

  const createRefUrl = `https://api.github.com/repos/${owner}/${repo}/git/refs`;
  const createRes = await githubFetch(
    createRefUrl,
    {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: baseSha
      })
    },
    token
  );

  if (createRes.status === 201) {
    return;
  }

  // 422 can happen on race condition if branch was created in-between
  if (createRes.status === 422) {
    return;
  }

  const payload = await createRes.json().catch(() => ({}));
  throw new Error(payload?.message || `Unable to create branch '${branch}'.`);
}

export async function POST(request) {
  try {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const defaultPublishBranch =
      process.env.GITHUB_PUBLISH_BRANCH || process.env.GITHUB_BRANCH || 'generated-geojson';
    const defaultBaseBranch = process.env.GITHUB_BASE_BRANCH || 'main';

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
    const branch = sanitizeBranch(body?.branch, defaultPublishBranch);
    const baseBranch = sanitizeBranch(body?.baseBranch, defaultBaseBranch);
    const commitMessage = String(body?.message || 'chore: publish generated geojson');
    const geojson = body?.geojson;

    if (!geojson || geojson.type !== 'FeatureCollection') {
      return NextResponse.json({ error: 'Body must include a GeoJSON FeatureCollection in `geojson`.' }, { status: 400 });
    }

    const content = JSON.stringify(geojson, null, 2) + '\n';
    const contentBase64 = Buffer.from(content, 'utf8').toString('base64');

    await ensureBranchExists({
      token,
      owner,
      repo,
      branch,
      baseBranch
    });

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
      baseBranch,
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
