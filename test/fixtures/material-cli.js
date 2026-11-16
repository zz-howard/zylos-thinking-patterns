import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync(process.env.MATERIAL_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
fs.appendFileSync(process.env.MATERIAL_CALLS, JSON.stringify(args) + '\n');
if (data.fail && args.includes('--checkpoints')) { console.error('Unknown option --checkpoints'); process.exit(1); }
let output;
if (args[0] === 'groups') output = { ok: true, data: data.groups.map(sessionGroup => ({ sessionGroup })) };
else if (args.includes('--checkpoints')) output = data.checkpoints.filter(c => c.session_group === (args.includes('--group') ? value('--group') : '*') && c.id > Number(value('--after')));
else if (args.includes('--since')) output = { rows: data.rows.filter(r => Date.parse(r.timestamp.includes('Z') ? r.timestamp : r.timestamp.replace(' ', 'T') + 'Z') >= Date.parse(value('--since'))) };
else if (args.includes('--begin')) output = { rows: data.rows.filter(r => r.id >= Number(value('--begin')) && r.id <= Number(value('--end'))) };
else if (args[0] === 'recent') output = data.rows.slice(-Number(args[1]));
else { console.error('Unsupported fixture invocation'); process.exit(1); }
console.log(JSON.stringify(output));
