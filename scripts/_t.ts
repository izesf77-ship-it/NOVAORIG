console.log('ts works');
const fs = await import('node:fs');
fs.writeFileSync('c:/Users/admin/Desktop/NOVA/_probe2.txt', 'ts-ok', 'utf8');
console.log('probe written');