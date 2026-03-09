import { Generator } from '@jspm/generator';
import fs from 'fs';

export async function generate(modulePath = process.env.MODULE_PATH || '/node_modules/') {
    const generator = new Generator({
        defaultProvider: 'nodemodules',
        env: ['production', 'module', 'browser'],
        integrity: true,
    });

    const packageJSONStr = fs.readFileSync('package.json', 'utf8');
    const packageJSON = JSON.parse(packageJSONStr);

    if (packageJSON.dependencies) {
        for (const [key, value] of Object.entries(packageJSON.dependencies)) {
            await generator.install(key);
        }
    }

    let importMap = JSON.stringify(generator.getMap(), null, 2);
    importMap = importMap.replaceAll(/\.\/node_modules/g, modulePath);

    console.log('The import map is:', importMap);
    fs.writeFileSync('importmap.json', importMap);
}
