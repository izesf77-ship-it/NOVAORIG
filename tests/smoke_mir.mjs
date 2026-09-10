import { compileSources } from '../src/compiler/driver.ts';
import { astToHir } from '../src/compiler/hir/hir_lower.ts';
import { mirLowerModule } from '../src/compiler/mir/mir_lower.ts';

const src = `
enum Color { Red, Green, Blue }
fn name(c: Color) -> String {
  match c {
    Color.Red => "red"
    Color.Green => "green"
    Color.Blue => "blue"
  }
}
fn main() { print(name(Color.Green)) }
`;

const r = compileSources([{ file: 't.nova', source: src }]);
const hir = astToHir(r.programs, r.symbols, r.exprTypes);
const mir = mirLowerModule(hir, r.symbols);

for (const d of mir.decls) {
  if (d.kind === 'fn') {
    console.log('fn', d.name);
    for (const b of d.blocks) {
      const t = b.term;
      let tdesc = t.kind;
      if (t.kind === 'branch') tdesc += ` {${t.thenLabel} : ${t.elseLabel}}`;
      if (t.kind === 'jump') tdesc += ` -> ${t.target}`;
      if (t.kind === 'return') tdesc += ` ${t.value ? 'val' : 'void'}`;
      console.log('  ', b.label, 'instrs:', b.instrs.map(i => i.kind), 'term:', tdesc);
    }
  } else if (d.kind === 'closure_fn') {
    console.log('closure_fn', d.name, 'captured:', d.captured);
    for (const b of d.blocks) {
      const t = b.term;
      let tdesc = t.kind;
      if (t.kind === 'branch') tdesc += ` {${t.thenLabel} : ${t.elseLabel}}`;
      if (t.kind === 'jump') tdesc += ` -> ${t.target}`;
      if (t.kind === 'return') tdesc += ` ${t.value ? 'val' : 'void'}`;
      console.log('  ', b.label, 'instrs:', b.instrs.map(i => i.kind), 'term:', tdesc);
    }
  }
}

// Also test closure
console.log('\n--- closure test ---');
const src2 = `
fn main() {
  x = 10
  f = |n| n + x
  print(f(5))
}
`;
const r2 = compileSources([{ file: 't2.nova', source: src2 }]);
const hir2 = astToHir(r2.programs, r2.symbols, r2.exprTypes);
const mir2 = mirLowerModule(hir2, r2.symbols);
for (const d of mir2.decls) {
  if (d.kind === 'fn') {
    console.log('fn', d.name);
    for (const b of d.blocks) {
      const t = b.term;
      let tdesc = t.kind;
      if (t.kind === 'branch') tdesc += ` {${t.thenLabel} : ${t.elseLabel}}`;
      if (t.kind === 'jump') tdesc += ` -> ${t.target}`;
      if (t.kind === 'return') tdesc += ` ${t.value ? 'val' : 'void'}`;
      console.log('  ', b.label, 'instrs:', b.instrs.map(i => i.kind), 'term:', tdesc);
    }
  } else if (d.kind === 'closure_fn') {
    console.log('closure_fn', d.name, 'captured:', d.captured);
    for (const b of d.blocks) {
      const t = b.term;
      let tdesc = t.kind;
      if (t.kind === 'branch') tdesc += ` {${t.thenLabel} : ${t.elseLabel}}`;
      if (t.kind === 'jump') tdesc += ` -> ${t.target}`;
      if (t.kind === 'return') tdesc += ` ${t.value ? 'val' : 'void'}`;
      console.log('  ', b.label, 'instrs:', b.instrs.map(i => i.kind), 'term:', tdesc);
    }
  }
}
