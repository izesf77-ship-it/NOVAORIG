import { compile } from './src/compiler/driver.ts';
import { astToHir } from './src/compiler/hir/hir_lower.ts';
import { mirLowerModule } from './src/compiler/mir/mir_lower.ts';
import { verifyMirModule } from './src/compiler/mir/mir_verify.ts';
import { buildNative } from './src/compiler/backend/llvm_backend.ts';
import * as fs from 'node:fs';

console.log('[1] compile');
const compiled = compile('tests/native/hello.nova');
console.log('[2] hir');
const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
console.log('[3] mir');
const mir = mirLowerModule(hir, compiled.symbols);
console.log('[4] verify');
console.log(JSON.stringify(verifyMirModule(mir)));
console.log('[5] native');
const result = buildNative(mir, compiled.symbols, 'tests/native/dist/probe', { release: true, emit: 'exe' });
console.log('[6] done', result.exePath, fs.existsSync(result.exePath ?? ''));
