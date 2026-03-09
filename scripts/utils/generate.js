#!/usr/bin/env node

import { Generator } from '@jspm/generator';
import fs from 'fs';

const generator = new Generator({
    defaultProvider: 'nodemodules',
    env: ['production', 'module', 'browser'],
    integrity: true,
});

try {
    const packageJSONStr = fs.readFileSync('package.json', 'utf8');
    const packageJSON = JSON.parse(packageJSONStr);

    for (const [key, value] of Object.entries(packageJSON.dependencies)) {
        await generator.install(key);
    }

    let importMap = JSON.stringify(generator.getMap(), null, 2)

    importMap = importMap.replaceAll(/\.\/node_modules/g, process.env.MODULE_PATH)

    console.log('The import map is:', importMap);

    fs.writeFileSync('importmap.json', importMap);
} catch (err) {
    console.error('Error:', err);
    process.exit(1);
}
