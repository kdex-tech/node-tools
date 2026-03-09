import { optimize } from '../optimize.js';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

async function testOptimize() {
    const testDir = './test_node_modules';
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir);
    
    const subDir = path.join(testDir, 'sample_pkg');
    fs.mkdirSync(subDir);
    
    const jsFile = path.join(subDir, 'index.js');
    const content = 'console.log("hello world");';
    fs.writeFileSync(jsFile, content);
    
    console.log('--- Running optimize test ---');
    await optimize(testDir);
    
    const optimizedContent = fs.readFileSync(jsFile, 'utf8');
    assert.ok(optimizedContent.includes('sourceMappingURL='), 'Optimized file should contain source map');
    console.log('--- Optimize test passed ---');
    
    fs.rmSync(testDir, { recursive: true });
}

testOptimize().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
