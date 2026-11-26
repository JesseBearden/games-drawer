import { createHash, createHmac } from 'node:crypto';

/**
 * Talking to AWS straight over HTTPS, with no AWS library: Signature Version 4, and the box's own
 * role from the EC2 metadata service. Used by the photo check (Rekognition) and the minute counts
 * (CloudWatch).
 */

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

