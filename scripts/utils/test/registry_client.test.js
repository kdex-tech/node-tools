import assert from 'assert';

import {
    authHeaderFor,
    fetchPackumentVersion,
    fetchTarball,
    packumentUrl,
    parseNpmrc,
    resolveRegistry,
} from '../registry_client.js';

// node-tools#9: packages are installed with bun and verified with npm, and the
// two resolve registry config differently. npm rebuilt an Artifact Registry
// tarball URL without the repository path
// (https://…pkg.dev/@kdex-tech/ui/-/ui-1.2.17.tgz) and 400'd, so a package the
// #161 guard exists to protect shipped `unverified` with the Job exiting 0.
//
// node-tools#10: each verification spawned the npm CLI twice per dependency.
//
// Both dissolve if the verifier reads the packument itself and follows the
// dist.tarball the registry advertises, instead of letting a second tool
// reconstruct a URL. These cover that reader.

// --- parseNpmrc ---------------------------------------------------------

{
    const cfg = parseNpmrc(`
registry=https://registry.npmjs.org/
@kdex-tech:registry=https://northamerica-northeast2-npm.pkg.dev/augeinnovations/kdex-npm/
//northamerica-northeast2-npm.pkg.dev/augeinnovations/kdex-npm/:_authToken=AR-TOKEN
//gitlab.com/api/v4/:_authToken=GL-TOKEN
//gitlab.com/api/v4/:always-auth=true
`);
    assert.strictEqual(cfg.registries.default, 'https://registry.npmjs.org/');
    assert.strictEqual(
        cfg.registries['@kdex-tech'],
        'https://northamerica-northeast2-npm.pkg.dev/augeinnovations/kdex-npm/',
    );
    // always-auth is a dead npm config key; it must not be mistaken for auth.
    assert.strictEqual(cfg.auth.some((a) => a.prefix.includes('always-auth')), false);
}

{
    // Comments and blank lines are not configuration.
    const cfg = parseNpmrc('# registry=https://evil.example/\n\n  \nregistry=https://good.example/\n');
    assert.strictEqual(cfg.registries.default, 'https://good.example/');
}

{
    // _auth (pre-encoded basic) and username/_password (base64 password) both
    // appear in real npmrc files.
    const cfg = parseNpmrc(`
//a.example/:_auth=YWxpY2U6c2VjcmV0
//b.example/:username=bob
//b.example/:_password=${Buffer.from('hunter2').toString('base64')}
`);
    assert.strictEqual(authHeaderFor('https://a.example/pkg', cfg), 'Basic YWxpY2U6c2VjcmV0');
    assert.strictEqual(
        authHeaderFor('https://b.example/pkg', cfg),
        `Basic ${Buffer.from('bob:hunter2').toString('base64')}`,
    );
}

{
    // npm and bun both expand ${VAR} in npmrc, and these files are assembled
    // from user-supplied Secrets that use that form. Not expanding it would
    // send the literal "${NPM_TOKEN}" as a bearer token -- a 401 that surfaces
    // as `unverified`, which is the exact silent-degradation class of
    // node-tools#9.
    const cfg = parseNpmrc(
        '//gitlab.com/api/v4/:_authToken=${NPM_TOKEN}\n@s:registry=${NPM_REGISTRY}\n',
        { NPM_TOKEN: 'from-env', NPM_REGISTRY: 'https://env.example/' },
    );
    assert.strictEqual(authHeaderFor('https://gitlab.com/api/v4/x', cfg), 'Bearer from-env');
    assert.strictEqual(resolveRegistry('@s/p', cfg), 'https://env.example/');
}

{
    // An unset variable must not become the literal placeholder.
    const cfg = parseNpmrc('//a.example/:_authToken=${MISSING_VAR}\n', {});
    assert.strictEqual(authHeaderFor('https://a.example/x', cfg), null);
}

// --- authHeaderFor: longest prefix, and never to a foreign host ---------

{
    const cfg = parseNpmrc(`
//gitlab.com/api/v4/:_authToken=BROAD
//gitlab.com/api/v4/projects/85475888/packages/npm/:_authToken=NARROW
`);
    assert.strictEqual(
        authHeaderFor('https://gitlab.com/api/v4/projects/85475888/packages/npm/@s/p', cfg),
        'Bearer NARROW',
        'the most specific configured prefix wins, as npm does it',
    );
    assert.strictEqual(
        authHeaderFor('https://gitlab.com/api/v4/groups/x/-/packages/npm/@s/p', cfg),
        'Bearer BROAD',
    );
}

{
    // The whole point of matching by prefix: a GitLab token must never travel
    // to registry.npmjs.org. node-tools#10 notes GitLab group-scoped tarball
    // paths 302 to npmjs, so this is a live redirect path, not a hypothetical.
    const cfg = parseNpmrc('//gitlab.com/api/v4/:_authToken=GL-TOKEN\n');
    assert.strictEqual(authHeaderFor('https://registry.npmjs.org/@s/p', cfg), null);
}

// --- resolveRegistry ----------------------------------------------------

{
    const cfg = parseNpmrc(`
registry=https://default.example/
@kdex-tech:registry=https://scoped.example/repo/
`);
    assert.strictEqual(resolveRegistry('@kdex-tech/ui', cfg), 'https://scoped.example/repo/');
    assert.strictEqual(resolveRegistry('@other/thing', cfg), 'https://default.example/');
    assert.strictEqual(resolveRegistry('lodash', cfg), 'https://default.example/');
}

{
    // No npmrc at all still has to resolve somewhere sensible.
    assert.strictEqual(resolveRegistry('lodash', parseNpmrc('')), 'https://registry.npmjs.org/');
}

// --- packumentUrl -------------------------------------------------------

{
    // Exactly the shape the issue quotes as working against GitLab: the scoped
    // name is NOT percent-encoded, and the registry's path prefix is kept.
    assert.strictEqual(
        packumentUrl('https://gitlab.com/api/v4/projects/85475888/packages/npm/', '@recourse-software/knowdrive-l10n'),
        'https://gitlab.com/api/v4/projects/85475888/packages/npm/@recourse-software/knowdrive-l10n',
    );
    // A registry without a trailing slash must not swallow its own last segment.
    assert.strictEqual(
        packumentUrl('https://northamerica-northeast2-npm.pkg.dev/augeinnovations/kdex-npm', '@kdex-tech/ui'),
        'https://northamerica-northeast2-npm.pkg.dev/augeinnovations/kdex-npm/@kdex-tech/ui',
    );
}

// --- fetchPackumentVersion ---------------------------------------------

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
        arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
        text: async () => JSON.stringify(body),
    };
}

{
    const calls = [];
    const cfg = parseNpmrc('//scoped.example/:_authToken=T\n@s:registry=https://scoped.example/repo/\n');
    const meta = await fetchPackumentVersion('@s/p', '1.2.3', {
        config: cfg,
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({ versions: { '1.2.3': { dist: { shasum: 'abc', tarball: 'https://scoped.example/t.tgz' } } } });
        },
    });

    assert.strictEqual(meta.dist.shasum, 'abc');
    assert.strictEqual(calls.length, 1, 'one HTTP read, not an npm CLI spawn');
    assert.strictEqual(calls[0].url, 'https://scoped.example/repo/@s/p');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer T');
    // The temporal gap versus the install's read is the entire #161 mechanism,
    // so this read must never be served from a cache.
    assert.match(String(calls[0].init.headers['Cache-Control'] ?? ''), /no-cache/);
}

{
    // Registries that serve the version document directly are also fine.
    const meta = await fetchPackumentVersion('p', '1.0.0', {
        config: parseNpmrc(''),
        fetchImpl: async () => jsonResponse({ name: 'p', version: '1.0.0', dist: { shasum: 'z' } }),
    });
    assert.strictEqual(meta.dist.shasum, 'z');
}

{
    // A version the registry does not carry is "cannot verify", and must say
    // which version rather than throwing something shapeless.
    await assert.rejects(
        () => fetchPackumentVersion('p', '9.9.9', {
            config: parseNpmrc(''),
            fetchImpl: async () => jsonResponse({ versions: { '1.0.0': {} } }),
        }),
        /9\.9\.9/,
    );
}

{
    await assert.rejects(
        () => fetchPackumentVersion('p', '1.0.0', {
            config: parseNpmrc(''),
            fetchImpl: async () => jsonResponse({}, { status: 404 }),
        }),
        /404/,
    );
}

// --- fetchTarball: redirects, and auth that does not follow -------------

{
    const seen = [];
    const cfg = parseNpmrc('//gitlab.com/api/v4/:_authToken=GL\n');
    const body = Buffer.from('tarball-bytes');

    const buf = await fetchTarball('https://gitlab.com/api/v4/x.tgz', {
        config: cfg,
        fetchImpl: async (url, init) => {
            seen.push({ url, auth: init.headers.Authorization ?? null });
            if (url.startsWith('https://gitlab.com')) {
                return {
                    ok: false, status: 302,
                    headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://registry.npmjs.org/x.tgz' : null) },
                };
            }
            return {
                ok: true, status: 200,
                headers: { get: () => null },
                arrayBuffer: async () => body,
            };
        },
    });

    assert.deepStrictEqual(Buffer.from(buf), body);
    assert.strictEqual(seen.length, 2, 'the redirect must be followed');
    assert.strictEqual(seen[0].auth, 'Bearer GL');
    assert.strictEqual(
        seen[1].auth, null,
        'the GitLab token must NOT be replayed to npmjs.org after the 302',
    );
}

{
    // A redirect chain that never terminates must not hang the build.
    await assert.rejects(
        () => fetchTarball('https://a.example/x.tgz', {
            config: parseNpmrc(''),
            fetchImpl: async () => ({
                ok: false, status: 302,
                headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://a.example/x.tgz' : null) },
            }),
        }),
        /redirect/i,
    );
}

console.log('registry_client.test.js: all assertions passed');
