import { generate } from '../generate.js';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

async function testGenerate() {
    const tmpDir = './test_generate_dir';
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir);
    
    const initialDir = process.cwd();
    process.chdir(tmpDir);
    
    try {
        const pkgContent = JSON.stringify({
            name: "test-pkg",
            dependencies: {}
        });
        fs.writeFileSync('package.json', pkgContent);
        
        console.log('--- Running generate test (Empty Deps) ---');
        await generate('/custom/node_modules');
        
        assert.ok(fs.existsSync('importmap.json'), 'importmap.json should be generated');
        console.log('--- Generate test (Empty Deps) passed ---');

        // Note: Full dependency testing requires a functional node_modules with the requested packages
        // available for jspm-generator's nodemodules provider.
    } finally {
        process.chdir(initialDir);
        fs.rmSync(tmpDir, { recursive: true });
    }
}

testGenerate().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
