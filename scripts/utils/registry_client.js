import fs from 'fs';
import path from 'path';

// Direct registry reads for verify_integrity.
//
// Verification used to shell out to the npm CLI twice per dependency: `npm
// view` for the packument, `npm pack` for the tarball. That cost a Node process
// start per call (node-tools#10), and — worse — it made a SECOND tool
// responsible for resolving registry configuration. Packages are installed with
// bun, so when npm resolved differently the verification simply failed:
//
//   npm error 400 Bad Request - GET https://…pkg.dev/@kdex-tech/ui/-/ui-1.2.17.tgz
//
// npm had reconstructed an Artifact Registry tarball URL without the repository
// path. The package ended `unverified`, the Job exited 0, and the #161 guard
// silently did not run for it (node-tools#9).
//
// The fix is to stop reconstructing URLs at all: read the packument, then
// follow the `dist.tarball` the registry itself advertises. That URL is
// authoritative by construction, so there is nothing left to get wrong — and it
// is what makes group-scoped GitLab registries work, since their manifest
// advertises the project-scoped tarball.

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

// npm and bun both expand ${VAR} in npmrc values, and the packager's npmrc is
// assembled from user-supplied Secrets that use that form. Without this, a
// token written as ${NPM_TOKEN} would be sent literally — a 401 that surfaces
// as `unverified` rather than as an error (node-tools#9).
function expandEnv(value, env) {
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? '');
}
const MAX_REDIRECTS = 5;

/**
 * Parse npmrc text into { registries, auth }.
 *
 * Only the keys this reader needs are interpreted. Everything else — including
 * `always-auth`, which npm itself no longer understands and warns about — is
 * ignored rather than guessed at.
 */
export function parseNpmrc(text, env = process.env) {
    const registries = {};
    const auth = new Map();

    for (const rawLine of String(text ?? '').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;

        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = expandEnv(line.slice(eq + 1).trim(), env);
        // An unset variable expands to empty; treating that as a value would
        // send the literal "${NPM_TOKEN}" as a credential.
        if (value === '') continue;

        if (key === 'registry') {
            registries.default = value;
            continue;
        }

        const scoped = key.match(/^(@[^:]+):registry$/);
        if (scoped) {
            registries[scoped[1]] = value;
            continue;
        }

        // Auth keys are "//host/path/:<field>". The prefix is what npm matches
        // a request URL against, so it is kept verbatim.
        if (!key.startsWith('//')) continue;
        const sep = key.lastIndexOf(':');
        if (sep === -1) continue;
        const prefix = key.slice(0, sep);
        const field = key.slice(sep + 1);
        if (!['_authToken', '_auth', 'username', '_password'].includes(field)) continue;

        const entry = auth.get(prefix) ?? {};
        entry[field] = value;
        auth.set(prefix, entry);
    }

    return {
        registries,
        auth: [...auth.entries()].map(([prefix, fields]) => ({ prefix, fields })),
    };
}

/** Read the npmrc the packager mounts beside package.json, if there is one. */
export function loadNpmrc(workdir, env = process.env) {
    const candidates = [
        env.NPM_CONFIG_USERCONFIG,
        workdir && path.join(workdir, '.npmrc'),
        env.HOME && path.join(env.HOME, '.npmrc'),
    ].filter(Boolean);

    let merged = '';
    for (const candidate of candidates) {
        try {
            merged += `${fs.readFileSync(candidate, 'utf8')}\n`;
        } catch {
            // A missing npmrc is normal — public registry, no auth.
        }
    }
    return parseNpmrc(merged, env);
}

/** The registry a package resolves from: its scope's, else the default. */
export function resolveRegistry(name, config) {
    const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null;
    return (scope && config.registries[scope]) || config.registries.default || DEFAULT_REGISTRY;
}

/**
 * The Authorization header for a URL, or null when nothing is configured for it.
 *
 * Matching is by longest configured prefix, which is both what npm does and the
 * property that keeps one registry's token from being sent to another's host —
 * the case that matters when a tarball URL redirects off-site.
 */
export function authHeaderFor(url, config) {
    const stripped = String(url).replace(/^https?:/, '');
    let best = null;
    for (const { prefix, fields } of config.auth) {
        if (!stripped.startsWith(prefix)) continue;
        if (!best || prefix.length > best.prefix.length) best = { prefix, fields };
    }
    if (!best) return null;

    const { _authToken, _auth, username, _password } = best.fields;
    if (_authToken) return `Bearer ${_authToken}`;
    if (_auth) return `Basic ${_auth}`;
    if (username && _password) {
        const password = Buffer.from(_password, 'base64').toString('utf8');
        return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    return null;
}

/**
 * The packument URL for a package.
 *
 * The scoped name is deliberately NOT percent-encoded: that is the form the
 * GitLab endpoints serve, and registry.npmjs.org accepts it too.
 */
export function packumentUrl(registry, name) {
    return `${String(registry).replace(/\/+$/, '')}/${name}`;
}

function headersFor(url, config, extra = {}) {
    const headers = {
        // The abbreviated ("corgi") packument carries dist and little else.
        // Registries that do not implement it serve the full document, which
        // reads identically for our purposes.
        Accept: 'application/vnd.npm.install-v1+json, application/json',
        // This read MUST be online. It is a second, LATER read than the
        // install's, and that temporal gap is the whole of the #161 guard.
        'Cache-Control': 'no-cache',
        ...extra,
    };
    const auth = authHeaderFor(url, config);
    if (auth) headers.Authorization = auth;
    return headers;
}

/**
 * Fetch the registry's current metadata for one exact version.
 *
 * Returns the version document (the object carrying `dist`). Throws on
 * anything that means "could not check", which the caller reports as
 * `unverified` rather than as a failure.
 */
export async function fetchPackumentVersion(name, version, { config, fetchImpl = fetch } = {}) {
    const url = packumentUrl(resolveRegistry(name, config), name);
    const response = await fetchImpl(url, { headers: headersFor(url, config), redirect: 'follow' });

    if (!response.ok) {
        throw new Error(`registry returned ${response.status} for ${url}`);
    }

    const body = await response.json();
    // Registries serve either the whole packument or, for a version-addressed
    // request, the version document itself.
    const meta = body?.versions?.[version] ?? (body?.version === version ? body : null);
    if (!meta) {
        throw new Error(`registry metadata for ${name} carries no version ${version}`);
    }
    return meta;
}

/**
 * Fetch a tarball by the URL the registry advertised.
 *
 * Redirects are followed BY HAND so the Authorization header can be recomputed
 * for each hop. Node's fetch replays request headers across a cross-origin
 * redirect, and GitLab's group-scoped tarball paths 302 to registry.npmjs.org —
 * so following automatically would hand a GitLab token to npmjs.
 */
export async function fetchTarball(tarballUrl, { config, fetchImpl = fetch } = {}) {
    let url = tarballUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetchImpl(url, {
            headers: headersFor(url, config, { Accept: 'application/octet-stream' }),
            redirect: 'manual',
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) throw new Error(`redirect from ${url} carried no Location`);
            url = new URL(location, url).toString();
            continue;
        }

        if (!response.ok) {
            throw new Error(`registry returned ${response.status} for ${url}`);
        }
        return Buffer.from(await response.arrayBuffer());
    }

    throw new Error(`too many redirects fetching ${tarballUrl}`);
}
