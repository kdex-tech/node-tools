import assert from 'assert';

import { integritySummary, ledgerStatusLine } from '../verify_integrity.js';

// node-tools#8: when resolveLedgerDir() returns null the ledger is off for
// every run, forever, and the only evidence was "(0 from ledger)" in the
// summary -- which reads identically to a legitimately cold first run. A prod
// packager Job spent 88% of its wall time on the cold path for 33 generations
// without anything saying so. These assert the state is self-reporting.
//
// node-tools#9: `unverified` is not `failed`, so a package the #161 guard was
// written to protect can ship with no verification at all while the Job exits
// 0. It has to be visible, and opt-in strict has to be able to make it fatal.

function counts({ checked = 0, fromLedger = 0, skipped = 0, unverified = 0, failures = 0 } = {}) {
    return {
        checked: Array.from({ length: checked }, (_, i) => ({
            name: `p${i}`, version: '1.0.0', files: 1, cached: i < fromLedger,
        })),
        skipped: Array.from({ length: skipped }, (_, i) => ({ name: `s${i}` })),
        unverified: Array.from({ length: unverified }, (_, i) => ({ name: `u${i}` })),
        failures: Array.from({ length: failures }, (_, i) => ({ name: `f${i}` })),
    };
}

// --- ledgerStatusLine ---------------------------------------------------

{
    assert.strictEqual(ledgerStatusLine('/cache/verify'), 'ledger: /cache/verify');
}

{
    const line = ledgerStatusLine(null);
    assert.match(line, /DISABLED/, 'a null ledger dir must say so in words');
    assert.match(line, /KDEX_CACHE_DIR/, 'and must name the env var that fixes it');
    assert.match(line, /NPM_CONFIG_CACHE/);
}

// --- integritySummary: disabled vs merely cold --------------------------

{
    // The distinction node-tools#8 is entirely about.
    const disabled = integritySummary({ ...counts({ checked: 23 }), ledgerDir: null });
    const cold = integritySummary({ ...counts({ checked: 23 }), ledgerDir: '/cache/verify' });

    assert.notStrictEqual(
        disabled.summary, cold.summary,
        'a disabled ledger must not report identically to a cold one',
    );
    assert.match(disabled.summary, /disabled/i);
    assert.match(cold.summary, /0 from ledger/);
}

{
    const { warnings } = integritySummary({ ...counts({ checked: 23 }), ledgerDir: null });
    assert.strictEqual(warnings.length, 1, 'a disabled ledger with work done is worth exactly one warning');
    assert.match(warnings[0], /KDEX_CACHE_DIR|NPM_CONFIG_CACHE/);
}

{
    // Nothing verified, so nothing was paid for -- no warning worth printing.
    const { warnings } = integritySummary({ ...counts({ checked: 0 }), ledgerDir: null });
    assert.deepStrictEqual(warnings, []);
}

// --- integritySummary: live ledger that never hits ----------------------

{
    // node-tools#8's third bullet: a live dir that misses everything means the
    // dir is not surviving between Jobs (an emptyDir), which is the same
    // permanent cold path wearing a different hat.
    const { warnings } = integritySummary({ ...counts({ checked: 23 }), ledgerDir: '/cache/verify' });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /not persisting|did not survive|no entries were reused/i);
}

{
    // A partial hit rate is normal (new pins), so it must stay quiet.
    const { warnings } = integritySummary({
        ...counts({ checked: 23, fromLedger: 22 }), ledgerDir: '/cache/verify',
    });
    assert.deepStrictEqual(warnings, []);
}

// --- integritySummary: unverified is loud (node-tools#9) ----------------

{
    const { warnings } = integritySummary({
        ...counts({ checked: 23, fromLedger: 23, unverified: 1 }), ledgerDir: '/cache/verify',
    });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /unverified/i);
    assert.match(warnings[0], /not verified|no verification|unchecked/i);
}

{
    // Both problems at once must both be reported, not just the first.
    const { warnings } = integritySummary({
        ...counts({ checked: 23, unverified: 2 }), ledgerDir: null,
    });
    assert.strictEqual(warnings.length, 2);
}

console.log('verify_reporting.test.js: all assertions passed');
