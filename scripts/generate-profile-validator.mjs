import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const schema = JSON.parse(await readFile(resolve(root, 'resources/schemas/turnstage-profile.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false, code: { esm: true, source: true }, formats: { 'date-time': true } });
ajv.addSchema(schema);
const output = resolve(root, 'web/src/generated');
await mkdir(output, { recursive: true });
const generated = standaloneCode(ajv, { validateProfile: schema.$id })
  .replaceAll('require("ajv/dist/runtime/ucs2length").default', 'ucs2length')
  .replaceAll('require("ajv/dist/runtime/equal").default', 'equal');
const imports = 'import ucs2length from "ajv/dist/runtime/ucs2length.js";\nimport equal from "ajv/dist/runtime/equal.js";\n';
await writeFile(resolve(output, 'profileSchemaValidator.mjs'), `${imports}${generated}\n`, 'utf8');
