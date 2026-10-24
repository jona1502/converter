// Small local measurement; no conversion speed claim or simulated load profile.
import {performance} from 'node:perf_hooks';
const base = process.argv[2] ?? 'http://localhost:8080';
const measurements = {};
for (const path of ['/api/v1/health/live', '/api/v1/capabilities']) {
  const values = [];
  for (let i = 0; i < 23; i++) {
    const start = performance.now();
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    await response.arrayBuffer();
    if (i >= 3) values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  measurements[path] = {requests: values.length, medianMs: +values[10].toFixed(2), p95Ms: +values[18].toFixed(2)};
}
console.log(JSON.stringify({base, measuredAt: new Date().toISOString(), measurements}, null, 2));
