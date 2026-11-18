/** Same-origin server API. Files stay local until createJob is explicitly called. */
import type {ApiSchemas} from './generated';
export type Tool = ApiSchemas['Tool'];
export type JobResult = ApiSchemas['JobResultView'];
export type Job = ApiSchemas['JobView'];
export interface Capabilities {
  image: {outputFormats: string[]; inputFormats: string[]; maxFileBytes: number; maxPixels: number; maxEdge: number};
  jobs: {ttlSeconds: number; maxActivePerSession: number; maxBatchFiles: number};
  pdf: {maxFileBytes: number};
  /** Fehlt bei älteren Servern; dann ist audio-convert nicht verfügbar. */
  audio?: ApiSchemas['AudioCapabilities'];
  /** Fehlt bei älteren Servern; dann ist markdown-pdf nicht verfügbar. */
  markdown?: ApiSchemas['MarkdownCapabilities'];
  /** Fehlt bei älteren Servern; dann ist pdf-rotate nicht verfügbar. */
  pdfRotate?: ApiSchemas['PdfRotateCapabilities'];
  tools?: Tool[];
}
const messages: Record<string, string> = {
  'session-required': 'Ihre Sitzung ist abgelaufen. Bitte starten Sie die Verarbeitung erneut.',
  'csrf-failed': 'Die Sitzung konnte nicht bestätigt werden. Bitte laden Sie die Seite neu.',
  'file-too-large': 'Die Datei überschreitet die zulässige Größe.',
  'dimensions-too-large': 'Die Bildabmessungen überschreiten die zulässige Grenze.',
  'unsupported-type': 'Dieses Dateiformat wird nicht unterstützt oder die Datei ist beschädigt.',
  'animated-unsupported': 'Animierte Bilder werden nicht unterstützt.',
  'original-format-unsupported': 'Das Originalformat kann nicht ausgegeben werden. Wählen Sie ein anderes Zielformat.',
  'invalid-options': 'Bitte prüfen Sie die gewählten Einstellungen.',
  'invalid-request': 'Die Anfrage konnte nicht verarbeitet werden. Bitte prüfen Sie Datei und Einstellungen.',
  'rate-limited': 'Zu viele Anfragen. Die Verarbeitung wartet und versucht es erneut.',
  'session-job-limit': 'Ihre bisherigen Aufträge werden noch verarbeitet. Bitte warten Sie.',
  'server-busy': 'Der Server ist ausgelastet. Bitte versuchen Sie es später erneut.',
  'storage-full': 'Der Dateispeicher ist derzeit ausgelastet. Bitte versuchen Sie es später erneut.',
  'job-not-found': 'Der Auftrag wurde gelöscht oder ist nicht mehr verfügbar.',
  'job-expired': 'Der Auftrag ist abgelaufen. Bitte verarbeiten Sie die Datei erneut.',
  'idempotency-conflict': 'Diese Anfrage passt nicht mehr zum ursprünglichen Auftrag. Bitte starten Sie erneut.',
  'not-pdf': 'Die Datei ist keine erkennbare PDF.',
  'encrypted': 'Verschlüsselte PDFs werden nicht unterstützt.',
  'parse-failed': 'Die PDF ist beschädigt oder kann nicht gelesen werden.',
  'cancelled': 'Die Verarbeitung wurde abgebrochen.',
  'timeout': 'Die Verarbeitung hat das Zeitlimit überschritten.',
  'memory-limit': 'Für diese Datei reicht der verfügbare Arbeitsspeicher nicht aus.',
};
export class ApiError extends Error {
  constructor(public code: string, public status = 0, public retryAfter = 1) {
    super(messages[code] ?? 'Der Server konnte die Datei nicht verarbeiten. Bitte versuchen Sie es erneut.');
  }
}
export function apiMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Der Server ist nicht erreichbar. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut.';
}
const prefix = '/api/v1';
let sessionPromise: Promise<string> | null = null;
async function decode<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const retry = response.headers.get('retry-after');
    const seconds = retry && Number.isFinite(Number(retry)) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : 1;
    throw new ApiError(body?.error?.code ?? 'internal-error', response.status, Math.max(1, Math.min(seconds || 1, 60)));
  }
  return response.status === 204 ? undefined as T : response.json();
}
async function csrf(): Promise<string> {
  if (!sessionPromise) sessionPromise = fetch(`${prefix}/session`, {credentials: 'same-origin', cache: 'no-store'})
    .then(decode<{csrfToken: string}>).then(value => value.csrfToken)
    .catch(error => {sessionPromise = null; throw error;});
  return sessionPromise;
}
export async function capabilities(signal?: AbortSignal): Promise<Capabilities> {
  return decode(await fetch(`${prefix}/capabilities`, {signal, cache: 'no-store', credentials: 'same-origin'}));
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Abgebrochen', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Abgebrochen', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });
}
export async function createJob(file: File, options: Record<string, unknown>, key: string, signal: AbortSignal, onWaiting?: (waiting:boolean)=>void): Promise<Job> {
  const token = await csrf();
  const body = new FormData();
  body.append('options', JSON.stringify(options));
  body.append('file', file);
  const schedulingDeadline=Date.now()+15*60_000;
  for (;;) {
    try {
      return await decode(await fetch(`${prefix}/jobs`, {method: 'POST', credentials: 'same-origin',
        headers: {'X-CSRF-Token': token, 'Idempotency-Key': key}, body, signal}));
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ApiError && error.status === 401) sessionPromise = null;
      const scheduling=error instanceof ApiError&&(
        (error.status===429&&['rate-limited','session-job-limit'].includes(error.code))||
        (error.status===503&&error.code==='server-busy'));
      if (!scheduling || Date.now()+error.retryAfter*1000>schedulingDeadline) throw error;
      onWaiting?.(true);
      await delay(error.retryAfter * 1000, signal);
      onWaiting?.(false);
    }
  }
}
export async function deleteJob(id: string): Promise<void> {
  const token = await csrf();
  const response=await fetch(`${prefix}/jobs/${encodeURIComponent(id)}`, {method: 'DELETE', credentials: 'same-origin', headers: {'X-CSRF-Token': token}, keepalive: true});
  if(response.status!==404)await decode(response);
}
export async function cancelJob(id: string): Promise<void> {
  const token=await csrf();
  await decode(await fetch(`${prefix}/jobs/${encodeURIComponent(id)}/cancel`,{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':token}}));
}
/** Download-URL des ZIP-Archivs mit den Ergebnissen mehrerer fertiger Aufträge. */
export const archiveUrl = (jobIds: readonly string[]) =>
  `${prefix}/jobs/archive?${jobIds.map(id => `job_id=${encodeURIComponent(id)}`).join('&')}`;
export const terminal = (job: Job) => !['queued', 'running'].includes(job.state);
export async function pollJob(initial: Job, signal: AbortSignal, onStatus: (job: Job) => void): Promise<Job> {
  let job = initial, failures = 0;
  onStatus(job);
  while (!terminal(job)) {
    await delay(Math.min(1000 * 2 ** failures, 16000), signal);
    try {
      job = await decode(await fetch(`${prefix}/jobs/${encodeURIComponent(job.id)}`, {signal, credentials: 'same-origin', cache: 'no-store'}));
      failures = 0;
      onStatus(job);
    } catch (error) {
      if (signal.aborted || (error instanceof ApiError && error.status < 500 && error.status !== 429) || ++failures >= 5) throw error;
    }
  }
  return job;
}
