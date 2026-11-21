import { createHash, createHmac } from 'node:crypto';

/**
 * The automatic check for photos people upload for a jigsaw: Amazon Rekognition's moderation
 * labels (DetectModerationLabels), called straight over HTTPS with the box's own AWS role, so
 * the server needs no AWS library. The photo is sent as bytes in the request (never stored in
 * S3), and nobody looks at it.
 *
 * What's refused: nudity and sexual content, violence and gore, disturbing images, hate symbols
 * and rude gestures. What's fine: swimsuits, a bare-chested dad at the beach, a kiss, drinks,
 * cigarettes.
 */

/** One label as Rekognition returns it. */
export interface ModerationLabel {
  Name?: string;
  ParentName?: string;
  Confidence?: number;
  TaxonomyLevel?: number;
}

export type PhotoVerdict =
  | { ok: true }
  | { ok: false; reason: 'blocked'; categories: string[] }
  /** Not a picture Rekognition can read. */
  | { ok: false; reason: 'bad-image' };

export interface PhotoChecker {
  readonly name: string;
  /** Throws if the check couldn't be done (the photo is then refused: never unchecked). */
  check(jpeg: Buffer, size: { width: number; height: number }): Promise<PhotoVerdict>;
}

/** Labels below this confidence (out of 100) aren't returned. */
export const MIN_CONFIDENCE = 60;

/**
 * Categories that refuse a photo, by name (any level). Rekognition's current labels (model 7)
 * first, then the older names (model 6) in case an account still gets those.
 */
const BLOCK = new Set(
  [
    'Explicit',
    'Explicit Nudity',
    'Explicit Sexual Activity',
    'Sex Toys',
    'Non-Explicit Nudity of Intimate parts and Kissing',
    'Non-Explicit Nudity',
    'Obstructed Intimate Parts',
    'Violence',
    'Graphic Violence',
    'Weapon Violence',
    'Physical Violence',
    'Self-Harm',
    'Visually Disturbing',
    'Rude Gestures',
    'Middle Finger',
    'Hate Symbols',
    'Nazi Party',
    'White Supremacy',
    'Extremist',
    // Model 6.
    'Suggestive',
    'Graphic Male Nudity',
    'Graphic Female Nudity',
    'Sexual Activity',
    'Partial Nudity',
    'Sexual Situations',
  ].map((s) => s.toLowerCase()),
);

/**
 * The most specific labels that are fine even though their category is refused: family photos
 * at the beach or a wedding. (Swimwear has a category of its own in model 7, which isn't refused.)
 */
const ALLOW = new Set(
  [
    'Exposed Male Nipple',
    'Bare Back',
    'Kissing on the Lips',
    // Model 6 ("Suggestive").
    'Female Swimwear Or Underwear',
    'Male Swimwear Or Underwear',
    'Barechested Male',
    'Revealing Clothes',
  ].map((s) => s.toLowerCase()),
);

/**
 * Decide from Rekognition's labels. Only the most specific labels it returned count (a label
 * that's another one's parent is just its category), so "Exposed Male Nipple" under
 * "Non-Explicit Nudity" is fine while "Partially Exposed Female Breast" there is not. Returns
 * the top-level categories that refused it.
 */
export function judgeLabels(labels: readonly ModerationLabel[]): { blocked: boolean; categories: string[] } {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  const parentOf = new Map<string, string>();
  for (const l of labels) if (norm(l.Name)) parentOf.set(norm(l.Name), norm(l.ParentName));
  const parents = new Set([...parentOf.values()].filter(Boolean));
  const categories = new Set<string>();
  for (const l of labels) {
    const name = norm(l.Name);
    if (!name || parents.has(name) || ALLOW.has(name)) continue;
    const chain = [name];
    for (let p = norm(l.ParentName); p && chain.length < 6; p = parentOf.get(p) ?? '') chain.push(p);
    if (chain.some((c) => BLOCK.has(c))) categories.add(chain[chain.length - 1]);
  }
  return { blocked: categories.size > 0, categories: [...categories].sort() };
}

/**
 * For tests and for running the site on your own computer (no AWS there): every photo passes,
 * except one exactly 404 pixels wide, so tests can try a refused photo.
 */
export const pretendChecker: PhotoChecker = {
  name: 'pretend',
  async check(_jpeg, size) {
    return size.width === 404 ? { ok: false, reason: 'blocked', categories: ['pretend'] } : { ok: true };
  },
};

// ------------------------------------------------------------------ AWS

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When they stop working (ms), for ones that expire. */
  expiration?: number;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/**
 * Sign a request the way AWS wants (Signature Version 4). Returns every header to send,
 * `host` and `authorization` included. (Fetch sets `host` itself, from the URL.)
 */
export function signV4(r: {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}): Record<string, string> {
  const amzDate = r.now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = v;
  headers.host = r.host;
  headers['x-amz-date'] = amzDate;
  if (r.credentials.sessionToken) headers['x-amz-security-token'] = r.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [r.method, r.path, r.query ?? '', canonicalHeaders, signedHeaders, sha256(r.body)].join('\n');
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${r.credentials.secretAccessKey}`, day), r.region), r.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${r.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/**
 * AWS credentials: from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN) if set,
 * otherwise the box's own role from the EC2 metadata service (IMDSv2), kept until 5 minutes
 * before they expire.
 */
export function awsCredentials(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): () => Promise<AwsCredentials> {
  let cached: AwsCredentials | null = null;
  const imds = 'http://169.254.169.254/latest';
  const get = async (path: string, init: RequestInit) => {
    const res = await fetchFn(imds + path, { ...init, signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`EC2 metadata ${path}: ${res.status}`);
    return res;
  };
  return async () => {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
    }
    if (cached && (cached.expiration ?? 0) - Date.now() > 5 * 60_000) return cached;
    const token = await (await get('/api/token', { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '300' } })).text();
    const headers = { 'x-aws-ec2-metadata-token': token };
    const role = (await (await get('/meta-data/iam/security-credentials/', { headers })).text()).split('\n')[0].trim();
    const c = (await (await get(`/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers })).json()) as {
      AccessKeyId: string;
      SecretAccessKey: string;
      Token: string;
      Expiration: string;
    };
    cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token, expiration: Date.parse(c.Expiration) };
    return cached;
  };
}

/** Rekognition's moderation check. */
export class RekognitionChecker implements PhotoChecker {
  readonly name = 'rekognition';
  private credentials: () => Promise<AwsCredentials>;
  private fetchFn: typeof fetch;

  constructor(
    private o: { region: string; credentials?: () => Promise<AwsCredentials>; fetch?: typeof fetch; now?: () => Date; timeoutMs?: number },
  ) {
    this.fetchFn = o.fetch ?? fetch;
    this.credentials = o.credentials ?? awsCredentials(process.env, this.fetchFn);
  }

  async check(jpeg: Buffer): Promise<PhotoVerdict> {
    const host = `rekognition.${this.o.region}.amazonaws.com`;
    const body = JSON.stringify({ Image: { Bytes: jpeg.toString('base64') }, MinConfidence: MIN_CONFIDENCE });
    const headers = signV4({
      method: 'POST',
      host,
      path: '/',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'RekognitionService.DetectModerationLabels' },
      body,
      region: this.o.region,
      service: 'rekognition',
      credentials: await this.credentials(),
      now: this.o.now?.() ?? new Date(),
    });
    delete headers.host;
    const res = await this.fetchFn(`https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
    const text = await res.text();
    if (!res.ok) {
      // A picture it can't read is the photo's fault; anything else is ours (and it's refused).
      if (res.status === 400 && /InvalidImageFormat|ImageTooLarge|InvalidParameter/.test(text)) return { ok: false, reason: 'bad-image' };
      throw new Error(`Rekognition ${res.status}: ${text.slice(0, 200)}`);
    }
    const out = JSON.parse(text) as { ModerationLabels?: ModerationLabel[] };
    const j = judgeLabels(out.ModerationLabels ?? []);
    return j.blocked ? { ok: false, reason: 'blocked', categories: j.categories } : { ok: true };
  }
}
